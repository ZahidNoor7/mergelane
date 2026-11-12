package winsvc

import (
	"context"
	"errors"
	"fmt"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// Recovery is what Windows does when the service stops without being asked: restart it, sooner the
// first time. After a day without a failure the count starts again (ResetPeriod).
var Recovery = []mgr.RecoveryAction{
	{Type: mgr.ServiceRestart, Delay: 1 * time.Second},
	{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
	{Type: mgr.ServiceRestart, Delay: 30 * time.Second},
}

// ResetPeriod is Recovery's reset period, in seconds.
const ResetPeriod = 24 * 60 * 60

// pollInterval is how often Stop and Start look at the service's state.
const pollInterval = 100 * time.Millisecond

// SCM is the real Manager, through golang.org/x/sys/windows/svc/mgr. Each call connects to the Service
// Control Manager, which needs administrator rights for everything but a query.
type SCM struct{}

var _ Manager = SCM{}

// open opens the service; ok is false when it doesn't exist.
func open() (m *mgr.Mgr, s *mgr.Service, ok bool, err error) {
	m, err = mgr.Connect()
	if err != nil {
		return nil, nil, false, err
	}
	s, err = m.OpenService(Name)
	if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		return m, nil, false, nil
	}
	if err != nil {
		m.Disconnect()
		return nil, nil, false, err
	}
	return m, s, true, nil
}

func closeAll(m *mgr.Mgr, s *mgr.Service) {
	if s != nil {
		s.Close()
	}
	if m != nil {
		m.Disconnect()
	}
}

// waitFor polls the service's state until it is want, ctx ends, or it settles in another state.
func waitFor(ctx context.Context, s *mgr.Service, want svc.State) error {
	for {
		st, err := s.Query()
		if err != nil {
			return err
		}
		if st.State == want {
			return nil
		}
		if want == svc.Running && st.State == svc.Stopped {
			return errors.New("the service stopped as it started; its log says why")
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("the service is still %s: %w", stateName(st.State), ctx.Err())
		case <-time.After(pollInterval):
		}
	}
}

func stateName(s svc.State) string {
	switch s {
	case svc.Stopped:
		return "stopped"
	case svc.StartPending:
		return "starting"
	case svc.StopPending:
		return "stopping"
	case svc.Running:
		return "running"
	}
	return fmt.Sprintf("in state %d", s)
}

func (SCM) Stop(ctx context.Context) error {
	m, s, ok, err := open()
	if err != nil || !ok {
		closeAll(m, s)
		return err
	}
	defer closeAll(m, s)
	st, err := s.Query()
	if err != nil {
		return err
	}
	if st.State == svc.Stopped {
		return nil
	}
	if st.State != svc.StopPending {
		if _, err := s.Control(svc.Stop); err != nil && !errors.Is(err, windows.ERROR_SERVICE_NOT_ACTIVE) {
			return err
		}
	}
	return waitFor(ctx, s, svc.Stopped)
}

func (SCM) Configure(binary string, args []string) error {
	m, s, ok, err := open()
	if err != nil {
		return err
	}
	defer func() { closeAll(m, s) }()
	if !ok {
		s, err = m.CreateService(Name, binary, mgr.Config{
			ServiceType:  windows.SERVICE_WIN32_OWN_PROCESS,
			StartType:    mgr.StartAutomatic,
			ErrorControl: mgr.ErrorNormal,
			DisplayName:  DisplayName,
			Description:  Description,
		}, args...)
		if err != nil {
			return err
		}
	} else {
		c, err := s.Config()
		if err != nil {
			return err
		}
		c.BinaryPathName = commandLine(binary, args)
		c.StartType = mgr.StartAutomatic
		c.DisplayName = DisplayName
		c.Description = Description
		c.ServiceStartName = "LocalSystem"
		if err := s.UpdateConfig(c); err != nil {
			return err
		}
	}
	if err := s.SetRecoveryActions(Recovery, ResetPeriod); err != nil {
		return err
	}
	// A run that ends with an error (say, it couldn't take the pipe) is a failure too.
	return s.SetRecoveryActionsOnNonCrashFailures(true)
}

// commandLine is the service's command line, quoted as CreateService quotes it.
func commandLine(binary string, args []string) string {
	line := syscall.EscapeArg(binary)
	for _, a := range args {
		line += " " + syscall.EscapeArg(a)
	}
	return line
}

func (SCM) Start(ctx context.Context) error {
	m, s, ok, err := open()
	if err != nil || !ok {
		closeAll(m, s)
		if err == nil {
			err = errors.New("the service isn't installed")
		}
		return err
	}
	defer closeAll(m, s)
	if err := s.Start(); err != nil && !errors.Is(err, windows.ERROR_SERVICE_ALREADY_RUNNING) {
		return err
	}
	return waitFor(ctx, s, svc.Running)
}

func (SCM) Delete() error {
	m, s, ok, err := open()
	if err != nil || !ok {
		closeAll(m, s)
		return err
	}
	defer closeAll(m, s)
	if err := s.Delete(); err != nil && !errors.Is(err, windows.ERROR_SERVICE_MARKED_FOR_DELETE) {
		return err
	}
	return nil
}
