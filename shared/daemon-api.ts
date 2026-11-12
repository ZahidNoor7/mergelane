/**
 * Control API between Mergelane.app and the root helper `mergelane-daemon`, protocol v1.
 *
 * This file mirrors the Go package `daemon/internal/api` exactly. Both sides test against the
 * example messages in `shared/fixtures/daemon-api/*.json`, named `<method>[.<variant>].request.json`,
 * `<method>[.<variant>].response.json` and `error.<code in kebab case>.response.json`.
 *
 * Wire format: newline-delimited JSON over the Unix stream socket `SOCKET_PATH` (ADR-0005). Every
 * line the client sends is one request; the daemon answers each with exactly one line, in order,
 * echoing its `id`. A connection may carry any number of requests. Errors that belong to no single
 * request (a peer that is not allowed, a line that is not JSON or is too long) come with `id: ""`;
 * after `NOT_AUTHORIZED` and after an over-long line the daemon closes the connection.
 *
 * Versions and compatibility:
 * - `v` is the wire format's version. A daemon accepts only its own (`UNSUPPORTED_VERSION`
 *   otherwise) and reports it as `StatusResult.protocol`, so `protocol` is also the oldest app
 *   protocol the daemon accepts: there is no separate "minAppProtocol" field, the two are equal by
 *   construction. An app first checks `status.protocol === PROTOCOL_VERSION`; on a mismatch it must
 *   not call anything else, and offers to update whichever side is older.
 * - Within one protocol version changes are additive only: a new method, a new optional param, a
 *   new result field. Result guards ignore unknown fields, so an older app keeps working with a newer
 *   daemon. A newer app must expect `UNKNOWN_METHOD` from an older daemon for a method added later:
 *   `setAutoResume` and `events` arrived in M2.4, still protocol 1, and a daemon from before M2.4
 *   answers both with `UNKNOWN_METHOD` (and sends no `autoResume` in status). `setStickySites`
 *   arrived with ADR-0048, likewise (an older daemon sends no `stickySites`). Anything that is not
 *   additive needs protocol 2.
 * - `StatusResult.version` is the daemon's build version, stamped with `-X main.version` (release
 *   builds use the app's package.json version; local builds say `dev`). The app compares it with its
 *   own version to offer a helper update.
 *
 * Dependency-free and erasable-syntax only, so it can be imported from the Electron main process,
 * the renderer and Node's type stripping alike.
 */

export const PROTOCOL_VERSION = 1;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

/** Where the daemon listens. */
export const SOCKET_PATH = "/var/run/mergelane/daemon.sock";

/** Longest request line the daemon reads, in bytes, not counting the newline. */
export const MAX_LINE_BYTES = 65536;

/** Largest per-link cap `setLimit` accepts, in Mbit/s. */
export const MAX_LIMIT_MBPS = 1e6;

/** How many link events the daemon keeps; `events` returns at most this many. */
export const MAX_EVENTS = 50;

/** `setAutoResume` and `events` were added in M2.4, `setStickySites` with ADR-0048: older daemons
 * answer `UNKNOWN_METHOD`. */
export const Method = {
  status: "status",
  enable: "enable",
  disable: "disable",
  links: "links",
  stats: "stats",
  setLimit: "setLimit",
  setAutoResume: "setAutoResume",
  events: "events",
  setStickySites: "setStickySites",
} as const;
export type Method = (typeof Method)[keyof typeof Method];
export const METHODS: readonly Method[] = Object.values(Method);

/** The methods whose params are required; every other method takes none or optional ones. */
export const METHODS_WITH_REQUIRED_PARAMS: readonly Method[] = [
  Method.setLimit,
  Method.setAutoResume,
  Method.setStickySites,
];
type MethodWithRequiredParams =
  | typeof Method.setLimit
  | typeof Method.setAutoResume
  | typeof Method.setStickySites;

/** Stable error codes. A code never changes meaning within a protocol version. */
export const ErrorCode = {
  /** Malformed, oversized or invalid request. */
  BAD_REQUEST: "BAD_REQUEST",
  /** `v` is not `PROTOCOL_VERSION`. */
  UNSUPPORTED_VERSION: "UNSUPPORTED_VERSION",
  /** `method` is not one of `METHODS`. */
  UNKNOWN_METHOD: "UNKNOWN_METHOD",
  /** The connecting user may not control the daemon. */
  NOT_AUTHORIZED: "NOT_AUTHORIZED",
  /** Another VPN owns the routes, so system merge refuses to turn on (or turned off). */
  VPN_ACTIVE: "VPN_ACTIVE",
  /** No link can carry traffic right now. */
  NO_USABLE_LINKS: "NO_USABLE_LINKS",
  /** The daemon lacks the privileges it needs. */
  NOT_ROOT: "NOT_ROOT",
  /** Anything else; the message says what. */
  INTERNAL: "INTERNAL",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
export const ERROR_CODES: readonly ErrorCode[] = Object.values(ErrorCode);

export const DAEMON_STATES = ["off", "on", "starting", "stopping"] as const;
export type DaemonState = (typeof DAEMON_STATES)[number];

export const LINK_STATES = ["up", "unknown", "down"] as const;
/** Result of a link's internet probe; `unknown` means not probed yet. */
export type LinkState = (typeof LINK_STATES)[number];

/** A link's state in `events`: a `LinkState`, or `gone` while its interface is not there. */
export const LINK_EVENT_STATES = ["up", "unknown", "down", "gone"] as const;
export type LinkEventState = (typeof LINK_EVENT_STATES)[number];

/**
 * Why a link's state changed. The set is closed within protocol 1, like `ErrorCode`.
 * - `found`: a link the daemon had not seen appeared (also every link at the daemon's start).
 * - `lost`: its interface, address or default route went away (unplugged, asleep).
 * - `returned`: a link that had gone came back, perhaps with a new interface index.
 * - `address`: its address changed, so it is checked again.
 * - `probe-ok` / `probe-failed`: the internet check through it passed / failed.
 */
export const LINK_EVENT_REASONS = [
  "found",
  "lost",
  "returned",
  "address",
  "probe-ok",
  "probe-failed",
] as const;
export type LinkEventReason = (typeof LINK_EVENT_REASONS)[number];

/** Result of `status`, `enable`, `disable`, `setAutoResume` and `setStickySites`. */
export interface StatusResult {
  state: DaemonState;
  /**
   * Why merging is off when it did not go off on request, e.g. a VPN conflict or a crash, and why
   * auto-resume did not turn it back on. While `state` is `on`, a reason is present only when
   * auto-resume turned merging back on after a crash.
   */
  reason?: string;
  /** When `state` last changed, RFC 3339. */
  since?: string;
  /** The daemon's build version (`-X main.version`); see "Versions and compatibility" above. */
  version: string;
  /** Always `PROTOCOL_VERSION`; also the oldest app protocol this daemon accepts. */
  protocol: ProtocolVersion;
  /**
   * The "turn system merge back on after a crash" setting (`setAutoResume`); off by default. Every
   * daemon since M2.4 sends it; an older daemon leaves it out and has no such setting.
   */
  autoResume?: boolean;
  /**
   * The "keep each site on one network" setting (`setStickySites`, ADR-0048); on by default. Every
   * daemon since ADR-0048 sends it; an older daemon leaves it out and keeps no site on one network.
   */
  stickySites?: boolean;
}

/** Params of methods that take none: absent, or an empty object. */
export type NoParams = Record<string, never>;

export interface DisableParams {
  /** Shown as `StatusResult.reason` afterwards. Absent means the user asked. */
  reason?: string;
}

export interface LinkInfo {
  /** BSD name, e.g. `en0`. */
  name: string;
  /** Interface index. */
  index: number;
  /** System Settings' name for the hardware port, e.g. `Wi-Fi` or `iPhone USB`. */
  kind?: string;
  ipv4?: string;
  ipv6?: string;
  /** The interface flag. */
  up: boolean;
  /** Whether the internet is reachable through the link. */
  state: LinkState;
  /** Cap in Mbit/s; absent means no cap. */
  limitMbps?: number;
}

export interface LinksResult {
  links: LinkInfo[];
}

/** One link's traffic. Rates are in bytes per second. */
export interface LinkStats {
  name: string;
  /** Traffic system merging sent through this link. */
  rxBps: number;
  txBps: number;
  /** Everything on the interface, from the OS's counters. */
  linkRxBps: number;
  linkTxBps: number;
  activeFlows: number;
  totalFlows: number;
  /** The link's share in the balancer. */
  weight: number;
  /** Flows that could not be connected through this link. */
  failed: number;
}

export interface StatsResult {
  /** RFC 3339. */
  at: string;
  links: LinkStats[];
}

export interface SetLimitParams {
  link: string;
  /** Mbit/s, 0 to `MAX_LIMIT_MBPS`; 0 removes the cap. */
  mbps: number;
}

/** The cap now in force. */
export interface SetLimitResult {
  link: string;
  mbps: number;
}

/** Saved by the daemon; takes effect at its next start after a crash. Result: `StatusResult`. */
export interface SetAutoResumeParams {
  enabled: boolean;
}

/** Saved by the daemon; takes effect for the next connections at once. Result: `StatusResult`. */
export interface SetStickySitesParams {
  enabled: boolean;
}

/** One change in a link's state, for the failover history. */
export interface LinkEvent {
  /** RFC 3339. */
  at: string;
  /** BSD name, e.g. `en0`. */
  link: string;
  /** The state `links` reported for it (IPv4's probe, or IPv6's on a link without IPv4). */
  from: LinkEventState;
  to: LinkEventState;
  reason: LinkEventReason;
}

/** The most recent link changes, oldest first, at most `MAX_EVENTS`. Kept in memory only, so the
 * list starts empty at every daemon start. */
export interface EventsResult {
  events: LinkEvent[];
}

/** Params and result type of every method. */
export interface MethodTypes {
  status: { params: NoParams; result: StatusResult };
  enable: { params: NoParams; result: StatusResult };
  disable: { params: DisableParams; result: StatusResult };
  links: { params: NoParams; result: LinksResult };
  stats: { params: NoParams; result: StatsResult };
  setLimit: { params: SetLimitParams; result: SetLimitResult };
  setAutoResume: { params: SetAutoResumeParams; result: StatusResult };
  events: { params: NoParams; result: EventsResult };
  setStickySites: { params: SetStickySitesParams; result: StatusResult };
}
export type ParamsOf<M extends Method> = MethodTypes[M]["params"];
export type ResultOf<M extends Method> = MethodTypes[M]["result"];

/** `setLimit`, `setAutoResume` and `setStickySites` are the methods whose params are required. */
export type Request<M extends Method = Method> = {
  [K in M]: {
    v: ProtocolVersion;
    id: string;
    method: K;
  } & (K extends MethodWithRequiredParams
    ? { params: ParamsOf<K> }
    : { params?: ParamsOf<K> });
}[M];

export interface ErrorBody {
  code: ErrorCode;
  message: string;
}

export interface OkResponse<R = unknown> {
  v: ProtocolVersion;
  id: string;
  ok: true;
  result: R;
}

export interface ErrorResponse {
  v: ProtocolVersion;
  /** `""` for errors that belong to no single request. */
  id: string;
  ok: false;
  error: ErrorBody;
}

export type Response<R = unknown> = OkResponse<R> | ErrorResponse;

// ---------------------------------------------------------------------------------------------
// Runtime guards. Each takes a value from JSON.parse and checks it the way the Go side does.
// Params are strict (unknown keys are refused, as the daemon refuses them); results and the
// envelope allow unknown keys, as the Go decoder ignores them.

type Obj = Record<string, unknown>;

const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isObj(x: unknown): x is Obj {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function onlyKeys(o: Obj, allowed: readonly string[]): boolean {
  return Object.keys(o).every((k) => allowed.includes(k));
}

function optional(
  o: Obj,
  key: string,
  check: (v: unknown) => boolean,
): boolean {
  return o[key] === undefined || check(o[key]);
}

function isString(x: unknown): x is string {
  return typeof x === "string";
}

function isBoolean(x: unknown): x is boolean {
  return typeof x === "boolean";
}

function isNonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x !== "";
}

function isNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function isCount(x: unknown): x is number {
  return Number.isSafeInteger(x) && (x as number) >= 0;
}

function isRate(x: unknown): x is number {
  return isNumber(x) && x >= 0;
}

function isTimestamp(x: unknown): x is string {
  return (
    typeof x === "string" && RFC3339.test(x) && !Number.isNaN(Date.parse(x))
  );
}

function isMbps(x: unknown): x is number {
  return isNumber(x) && x >= 0 && x <= MAX_LIMIT_MBPS;
}

export function isMethod(x: unknown): x is Method {
  return (METHODS as readonly unknown[]).includes(x);
}

export function isErrorCode(x: unknown): x is ErrorCode {
  return (ERROR_CODES as readonly unknown[]).includes(x);
}

export function isNoParams(x: unknown): x is NoParams {
  return isObj(x) && Object.keys(x).length === 0;
}

export function isDisableParams(x: unknown): x is DisableParams {
  return isObj(x) && onlyKeys(x, ["reason"]) && optional(x, "reason", isString);
}

export function isSetLimitParams(x: unknown): x is SetLimitParams {
  return (
    isObj(x) &&
    onlyKeys(x, ["link", "mbps"]) &&
    isNonEmptyString(x.link) &&
    isMbps(x.mbps)
  );
}

export function isSetAutoResumeParams(x: unknown): x is SetAutoResumeParams {
  return isObj(x) && onlyKeys(x, ["enabled"]) && isBoolean(x.enabled);
}

export function isSetStickySitesParams(x: unknown): x is SetStickySitesParams {
  return isObj(x) && onlyKeys(x, ["enabled"]) && isBoolean(x.enabled);
}

const paramGuards: { [M in Method]: (x: unknown) => x is ParamsOf<M> } = {
  status: isNoParams,
  enable: isNoParams,
  disable: isDisableParams,
  links: isNoParams,
  stats: isNoParams,
  setLimit: isSetLimitParams,
  setAutoResume: isSetAutoResumeParams,
  events: isNoParams,
  setStickySites: isSetStickySitesParams,
};

/** Whether `x` is a request the daemon accepts: envelope, method and params. */
export function isRequest(x: unknown): x is Request {
  if (
    !isObj(x) ||
    x.v !== PROTOCOL_VERSION ||
    !isNonEmptyString(x.id) ||
    !isMethod(x.method)
  ) {
    return false;
  }
  if (x.params === undefined)
    return !METHODS_WITH_REQUIRED_PARAMS.includes(x.method);
  return paramGuards[x.method](x.params);
}

export function isStatusResult(x: unknown): x is StatusResult {
  return (
    isObj(x) &&
    (DAEMON_STATES as readonly unknown[]).includes(x.state) &&
    optional(x, "reason", isString) &&
    optional(x, "since", isTimestamp) &&
    isString(x.version) &&
    x.protocol === PROTOCOL_VERSION &&
    optional(x, "autoResume", isBoolean) &&
    optional(x, "stickySites", isBoolean)
  );
}

export function isLinkInfo(x: unknown): x is LinkInfo {
  return (
    isObj(x) &&
    isNonEmptyString(x.name) &&
    isCount(x.index) &&
    optional(x, "kind", isString) &&
    optional(x, "ipv4", isString) &&
    optional(x, "ipv6", isString) &&
    typeof x.up === "boolean" &&
    (LINK_STATES as readonly unknown[]).includes(x.state) &&
    optional(x, "limitMbps", isMbps)
  );
}

export function isLinksResult(x: unknown): x is LinksResult {
  return isObj(x) && Array.isArray(x.links) && x.links.every(isLinkInfo);
}

export function isLinkStats(x: unknown): x is LinkStats {
  return (
    isObj(x) &&
    isNonEmptyString(x.name) &&
    isRate(x.rxBps) &&
    isRate(x.txBps) &&
    isRate(x.linkRxBps) &&
    isRate(x.linkTxBps) &&
    isCount(x.activeFlows) &&
    isCount(x.totalFlows) &&
    isNumber(x.weight) &&
    isCount(x.failed)
  );
}

export function isStatsResult(x: unknown): x is StatsResult {
  return (
    isObj(x) &&
    isTimestamp(x.at) &&
    Array.isArray(x.links) &&
    x.links.every(isLinkStats)
  );
}

export function isSetLimitResult(x: unknown): x is SetLimitResult {
  return isObj(x) && isNonEmptyString(x.link) && isMbps(x.mbps);
}

export function isLinkEvent(x: unknown): x is LinkEvent {
  return (
    isObj(x) &&
    isTimestamp(x.at) &&
    isNonEmptyString(x.link) &&
    (LINK_EVENT_STATES as readonly unknown[]).includes(x.from) &&
    (LINK_EVENT_STATES as readonly unknown[]).includes(x.to) &&
    (LINK_EVENT_REASONS as readonly unknown[]).includes(x.reason)
  );
}

export function isEventsResult(x: unknown): x is EventsResult {
  return isObj(x) && Array.isArray(x.events) && x.events.every(isLinkEvent);
}

const resultGuards: { [M in Method]: (x: unknown) => x is ResultOf<M> } = {
  status: isStatusResult,
  enable: isStatusResult,
  disable: isStatusResult,
  links: isLinksResult,
  stats: isStatsResult,
  setLimit: isSetLimitResult,
  setAutoResume: isStatusResult,
  events: isEventsResult,
  setStickySites: isStatusResult,
};

/** Whether `x` is a valid result of `method`. */
export function isResultOf<M extends Method>(
  method: M,
  x: unknown,
): x is ResultOf<M> {
  return resultGuards[method](x);
}

export function isErrorBody(x: unknown): x is ErrorBody {
  return isObj(x) && isErrorCode(x.code) && isNonEmptyString(x.message);
}

/**
 * Whether `x` is a well-formed response envelope: an ok response with a result object, or a
 * failed one with a known code and a message. Check the result with `isResultOf`.
 */
export function isResponse(x: unknown): x is Response {
  if (!isObj(x) || x.v !== PROTOCOL_VERSION || !isString(x.id)) return false;
  if (x.ok === true)
    return isObj(x.result) && (x.error === undefined || x.error === null);
  return x.ok === false && isErrorBody(x.error) && x.result === undefined;
}

export function isOkResponse(x: unknown): x is OkResponse {
  return isResponse(x) && x.ok;
}

export function isErrorResponse(x: unknown): x is ErrorResponse {
  return isResponse(x) && !x.ok;
}
