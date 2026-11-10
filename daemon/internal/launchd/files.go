package launchd

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

func (j *job) chownRoot(path string) error { return j.opts.Chown(path, rootUID, wheelGID) }

// ensureDir creates dir and any missing parents, each with mode 0755 and owned by root:wheel. Directories that
// already exist are left exactly as they are.
func (j *job) ensureDir(dir string) error {
	fi, err := os.Stat(dir)
	if err == nil {
		if !fi.IsDir() {
			return fmt.Errorf("%s exists and is not a directory", dir)
		}
		return nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if err := j.ensureDir(filepath.Dir(dir)); err != nil {
		return err
	}
	if err := os.Mkdir(dir, dirMode); err != nil {
		return err
	}
	if err := os.Chmod(dir, dirMode); err != nil { // Mkdir's mode is filtered through the umask
		return err
	}
	return j.chownRoot(dir)
}

// writeAtomic writes dst through a temporary file in the same directory: fill writes the content, the file is
// given root:wheel and mode, synced, closed and renamed over dst. rename(2) "guarantees that an instance of new
// will always exist", so dst is either the old file or the complete new one. On any failure the temporary file
// is removed and dst is untouched.
func (j *job) writeAtomic(dst string, mode fs.FileMode, fill func(io.Writer) error) (err error) {
	f, err := os.CreateTemp(filepath.Dir(dst), "."+filepath.Base(dst)+".tmp-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer func() {
		if err != nil {
			_ = f.Close()
			_ = os.Remove(tmp)
		}
	}()
	if err = fill(f); err != nil {
		return err
	}
	if err = j.chownRoot(tmp); err != nil {
		return err
	}
	if err = f.Chmod(mode); err != nil { // after chown, which may clear mode bits
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, dst)
}

// removeIfPresent removes path; a path that does not exist is fine.
func removeIfPresent(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// regularFile reports whether path is a regular file. A missing path is (false, nil).
func regularFile(path string) (bool, error) {
	fi, err := os.Stat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return fi.Mode().IsRegular(), nil
}
