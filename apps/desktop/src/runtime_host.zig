const std = @import("std");
const native_sdk = @import("native_sdk");

pub const snapshot_command = "atet.runtime.snapshot";
pub const dispatch_command = "atet.runtime.dispatch";
pub const renderer_event = "atet.runtime.event";

const main_window_id: native_sdk.WindowId = 1;
const max_pending_requests: usize = 64;
const max_queued_events: usize = 128;
const max_actions: usize = max_pending_requests * 2 + max_queued_events;
const reader_buffer_bytes: usize = native_sdk.bridge.max_response_bytes + 2;
const writer_buffer_bytes: usize = 16 * 1024;
const shutdown_poll_ms: i64 = 10;
const desktop_protocol_version: i64 = 3;

const production_origins = [_][]const u8{"zero://app"};
const development_origins = [_][]const u8{ "zero://app", "http://127.0.0.1:5173" };
const automation_origins = [_][]const u8{ "zero://app", "zero://inline" };

pub const BridgeProfile = enum {
    production,
    development,
    automation,

    /// Automation takes precedence because its inline document must work in
    /// both Debug and release-shaped verification builds.
    pub fn fromBuild(is_debug: bool, automation_enabled: bool) BridgeProfile {
        if (automation_enabled) return .automation;
        if (is_debug) return .development;
        return .production;
    }

    /// Use this same slice for Native SDK navigation and `RuntimeHost` bridge
    /// configuration so a build cannot navigate to an origin its bridge denies.
    pub fn origins(self: BridgeProfile) []const []const u8 {
        return switch (self) {
            .production => &production_origins,
            .development => &development_origins,
            .automation => &automation_origins,
        };
    }
};

const production_command_policies = [_]native_sdk.bridge.CommandPolicy{
    .{ .name = snapshot_command, .origins = &production_origins },
    .{ .name = dispatch_command, .origins = &production_origins },
};
const development_command_policies = [_]native_sdk.bridge.CommandPolicy{
    .{ .name = snapshot_command, .origins = &development_origins },
    .{ .name = dispatch_command, .origins = &development_origins },
};
const automation_command_policies = [_]native_sdk.bridge.CommandPolicy{
    .{ .name = snapshot_command, .origins = &automation_origins },
    .{ .name = dispatch_command, .origins = &automation_origins },
};
fn commandPolicies(profile: BridgeProfile) []const native_sdk.bridge.CommandPolicy {
    return switch (profile) {
        .production => &production_command_policies,
        .development => &development_command_policies,
        .automation => &automation_command_policies,
    };
}

fn bridgePolicy(profile: BridgeProfile) native_sdk.bridge.Policy {
    return .{
        .enabled = true,
        .commands = commandPolicies(profile),
    };
}

pub const PathOptions = struct {
    /// Development/test-only values have priority over matching environment
    /// variables. Every override is ignored when the host executable is inside
    /// a signed .app bundle.
    gateway_path: ?[]const u8 = null,
    runtime_root: ?[]const u8 = null,
    capture_helper_path: ?[]const u8 = null,
    face_analyzer_path: ?[]const u8 = null,
};

pub const RuntimePaths = struct {
    runtime_root: []u8,
    gateway_path: []u8,
    capture_helper_path: []u8,
    face_analyzer_path: []u8,

    pub fn deinit(self: *RuntimePaths, allocator: std.mem.Allocator) void {
        allocator.free(self.runtime_root);
        allocator.free(self.gateway_path);
        allocator.free(self.capture_helper_path);
        allocator.free(self.face_analyzer_path);
        self.* = undefined;
    }
};

pub const ResolvePathError = error{
    ConflictingRenamedEnvironment,
    InvalidAbsolutePath,
    MissingDevelopmentRuntimeRoot,
} || std.mem.Allocator.Error || std.process.ExecutablePathAllocError;

/// Packaged executables resolve immutable runtime tools only from their own
/// Contents/Resources/runtime directory. Development executables require
/// explicit absolute overrides and never guess from the process working dir.
pub fn resolveRuntimePaths(
    io: std.Io,
    allocator: std.mem.Allocator,
    parent: *const std.process.Environ.Map,
    options: PathOptions,
) ResolvePathError!RuntimePaths {
    const executable_path = try std.process.executablePathAlloc(io, allocator);
    defer allocator.free(executable_path);
    return resolveRuntimePathsForExecutable(allocator, parent, options, executable_path);
}

fn resolveRuntimePathsForExecutable(
    allocator: std.mem.Allocator,
    parent: *const std.process.Environ.Map,
    options: PathOptions,
    executable_path: []const u8,
) ResolvePathError!RuntimePaths {
    const packaged_root = try packagedRuntimeRoot(allocator, executable_path);
    defer if (packaged_root) |path| allocator.free(path);

    if (packaged_root) |root| return runtimePathsFromRoot(allocator, root, .{});

    const gateway_override = options.gateway_path orelse try renamedEnvironment(parent, "ATET_GATEWAY_PATH", "TRANSMUTE_GATEWAY_PATH");
    const helper_override = options.capture_helper_path orelse try renamedEnvironment(parent, "ATET_CAPTURE_HELPER", "TRANSMUTE_CAPTURE_HELPER");
    const face_analyzer_override = options.face_analyzer_path orelse try renamedEnvironment(parent, "ATET_FACE_ANALYZER", "TRANSMUTE_FACE_ANALYZER");
    const raw_runtime_root = options.runtime_root orelse root: {
        const gateway = gateway_override orelse return error.MissingDevelopmentRuntimeRoot;
        const bin_dir = std.fs.path.dirname(gateway) orelse return error.InvalidAbsolutePath;
        break :root std.fs.path.dirname(bin_dir) orelse return error.InvalidAbsolutePath;
    };
    return runtimePathsFromRoot(allocator, raw_runtime_root, .{
        .gateway_path = gateway_override,
        .capture_helper_path = helper_override,
        .face_analyzer_path = face_analyzer_override,
    });
}

fn renamedEnvironment(
    parent: *const std.process.Environ.Map,
    canonical: []const u8,
    predecessor: []const u8,
) error{ConflictingRenamedEnvironment}!?[]const u8 {
    const current = parent.get(canonical);
    const legacy = parent.get(predecessor);
    if (current != null and legacy != null and !std.mem.eql(u8, current.?, legacy.?)) {
        return error.ConflictingRenamedEnvironment;
    }
    return current orelse legacy;
}

const ToolOverrides = struct {
    gateway_path: ?[]const u8 = null,
    capture_helper_path: ?[]const u8 = null,
    face_analyzer_path: ?[]const u8 = null,
};

fn runtimePathsFromRoot(
    allocator: std.mem.Allocator,
    raw_runtime_root: []const u8,
    overrides: ToolOverrides,
) ResolvePathError!RuntimePaths {
    var paths: RuntimePaths = undefined;
    paths.runtime_root = try normalizedAbsolute(allocator, raw_runtime_root);
    errdefer allocator.free(paths.runtime_root);

    paths.gateway_path = if (overrides.gateway_path) |path|
        try normalizedAbsolute(allocator, path)
    else
        try joinAbsolute(allocator, &.{ paths.runtime_root, "bin", "atet-gateway" });
    errdefer allocator.free(paths.gateway_path);

    paths.capture_helper_path = if (overrides.capture_helper_path) |path|
        try normalizedAbsolute(allocator, path)
    else
        try joinAbsolute(allocator, &.{ paths.runtime_root, "bin", "atet-capture" });
    errdefer allocator.free(paths.capture_helper_path);

    paths.face_analyzer_path = if (overrides.face_analyzer_path) |path|
        try normalizedAbsolute(allocator, path)
    else
        try joinAbsolute(allocator, &.{ paths.runtime_root, "bin", "atet-face-analyzer" });
    return paths;
}

fn packagedRuntimeRoot(allocator: std.mem.Allocator, executable_path: []const u8) ResolvePathError!?[]u8 {
    const normalized = try normalizedAbsolute(allocator, executable_path);
    defer allocator.free(normalized);

    const macos_dir = std.fs.path.dirname(normalized) orelse return null;
    if (!std.mem.eql(u8, std.fs.path.basename(macos_dir), "MacOS")) return null;
    const contents_dir = std.fs.path.dirname(macos_dir) orelse return null;
    if (!std.mem.eql(u8, std.fs.path.basename(contents_dir), "Contents")) return null;
    const app_dir = std.fs.path.dirname(contents_dir) orelse return null;
    const app_name = std.fs.path.basename(app_dir);
    if (app_name.len <= ".app".len or !std.mem.endsWith(u8, app_name, ".app")) return null;
    return @as(?[]u8, try joinAbsolute(allocator, &.{ contents_dir, "Resources", "runtime" }));
}

fn normalizedAbsolute(allocator: std.mem.Allocator, path: []const u8) ResolvePathError![]u8 {
    if (!std.fs.path.isAbsolute(path) or std.mem.findScalar(u8, path, 0) != null) {
        return error.InvalidAbsolutePath;
    }
    return std.fs.path.resolve(allocator, &.{path});
}

fn joinAbsolute(allocator: std.mem.Allocator, parts: []const []const u8) ResolvePathError![]u8 {
    const joined = try std.fs.path.join(allocator, parts);
    defer allocator.free(joined);
    return normalizedAbsolute(allocator, joined);
}

const inherited_environment_keys = [_][]const u8{
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "TZ",
};

/// Constructs the gateway's complete environment instead of cloning the app's
/// environment. Credentials, proxies, loader knobs, SSH agents, and Bun/Node
/// option injection never cross the process boundary.
pub fn buildSanitizedEnvironment(
    allocator: std.mem.Allocator,
    parent: *const std.process.Environ.Map,
    paths: *const RuntimePaths,
) (std.mem.Allocator.Error || error{ConflictingRenamedEnvironment})!std.process.Environ.Map {
    var environment: std.process.Environ.Map = .init(allocator);
    errdefer environment.deinit();

    for (inherited_environment_keys) |key| {
        if (parent.get(key)) |value| try environment.put(key, value);
    }
    if (try renamedEnvironment(parent, "ATET_REPOSITORY_ROOT", "TRANSMUTE_REPOSITORY_ROOT")) |value| {
        try environment.put("ATET_REPOSITORY_ROOT", value);
    }
    if (environment.get("TMPDIR") == null) try environment.put("TMPDIR", "/tmp");
    if (environment.get("LANG") == null) try environment.put("LANG", "en_US.UTF-8");

    try environment.put("ATET_GATEWAY_PATH", paths.gateway_path);
    try environment.put("ATET_CAPTURE_HELPER", paths.capture_helper_path);
    try environment.put("ATET_FACE_ANALYZER", paths.face_analyzer_path);

    const gateway_dir = std.fs.path.dirname(paths.gateway_path) orelse paths.runtime_root;
    const helper_dir = std.fs.path.dirname(paths.capture_helper_path) orelse paths.runtime_root;
    const path = try std.fmt.allocPrint(
        allocator,
        "{s}:{s}:/usr/bin:/bin:/usr/sbin:/sbin",
        .{ gateway_dir, helper_dir },
    );
    defer allocator.free(path);
    try environment.put("PATH", path);
    return environment;
}

pub const CodecError = error{
    InvalidRequestId,
    InvalidJson,
    MessageTooLarge,
};

/// Encodes the private gateway envelope. `payload` remains the exact JSON value
/// supplied by the renderer bridge; it is not converted to a JSON string.
pub fn encodeRequest(
    allocator: std.mem.Allocator,
    id: []const u8,
    command: []const u8,
    payload: []const u8,
) (CodecError || std.mem.Allocator.Error)![]u8 {
    if (!validRequestId(id)) return error.InvalidRequestId;
    if (payload.len > native_sdk.bridge.max_message_bytes) return error.MessageTooLarge;
    if (!try std.json.validate(allocator, payload)) return error.InvalidJson;

    var output: std.Io.Writer.Allocating = .init(allocator);
    defer output.deinit();
    output.writer.writeAll("{\"id\":") catch return error.OutOfMemory;
    std.json.Stringify.value(id, .{}, &output.writer) catch return error.OutOfMemory;
    output.writer.writeAll(",\"command\":") catch return error.OutOfMemory;
    std.json.Stringify.value(command, .{}, &output.writer) catch return error.OutOfMemory;
    output.writer.writeAll(",\"payload\":") catch return error.OutOfMemory;
    output.writer.writeAll(payload) catch return error.OutOfMemory;
    output.writer.writeAll("}\n") catch return error.OutOfMemory;
    return output.toOwnedSlice();
}

fn validRequestId(id: []const u8) bool {
    if (id.len == 0 or id.len > native_sdk.bridge.max_id_bytes) return false;
    for (id) |byte| {
        if (byte <= 0x1f or byte == '"' or byte == '\\') return false;
    }
    return true;
}

pub const LineKind = union(enum) {
    response: struct {
        id: [native_sdk.bridge.max_id_bytes]u8,
        id_len: usize,
    },
    event,
};

fn jsonString(value: ?std.json.Value) ?[]const u8 {
    return switch (value orelse return null) {
        .string => |item| item,
        else => null,
    };
}

fn desktopProtocolVersionIsCurrent(value: ?std.json.Value) bool {
    return switch (value orelse return false) {
        .integer => |item| item == desktop_protocol_version,
        else => false,
    };
}

/// Validates and distinguishes the two private gateway output shapes without
/// changing the bytes delivered to Native SDK or the renderer.
pub fn classifyLine(allocator: std.mem.Allocator, line: []const u8) !LineKind {
    if (line.len == 0 or line.len > native_sdk.bridge.max_response_bytes) return error.InvalidGatewayLine;
    var parsed = std.json.parseFromSlice(std.json.Value, allocator, line, .{}) catch return error.InvalidGatewayLine;
    defer parsed.deinit();

    const object = switch (parsed.value) {
        .object => |value| value,
        else => return error.InvalidGatewayLine,
    };

    const id_value = object.get("id");
    const ok_value = object.get("ok");
    if (id_value != null or ok_value != null) {
        const id = jsonString(id_value) orelse return error.InvalidGatewayLine;
        const ok = switch (ok_value orelse return error.InvalidGatewayLine) {
            .bool => |value| value,
            else => return error.InvalidGatewayLine,
        };
        if (!validRequestId(id) or object.count() != 3) return error.InvalidGatewayLine;
        if (ok) {
            if (object.get("result") == null or object.get("error") != null) return error.InvalidGatewayLine;
        } else {
            if (object.get("result") != null) return error.InvalidGatewayLine;
            const error_object = switch (object.get("error") orelse return error.InvalidGatewayLine) {
                .object => |value| value,
                else => return error.InvalidGatewayLine,
            };
            if (error_object.count() != 2 or jsonString(error_object.get("code")) == null or jsonString(error_object.get("message")) == null) return error.InvalidGatewayLine;
        }

        var result: LineKind = .{ .response = .{ .id = undefined, .id_len = id.len } };
        @memcpy(result.response.id[0..id.len], id);
        return result;
    }

    if (line.len > native_sdk.platform.max_window_event_detail_bytes) return error.InvalidGatewayLine;
    const kind = jsonString(object.get("kind")) orelse return error.InvalidGatewayLine;
    if (!desktopProtocolVersionIsCurrent(object.get("protocolVersion"))) return error.InvalidGatewayLine;
    if (std.mem.eql(u8, kind, "snapshot-changed")) {
        if (object.count() != 3 or object.get("snapshot") == null) return error.InvalidGatewayLine;
        if (object.get("snapshot").? != .object) return error.InvalidGatewayLine;
        return .event;
    }
    if (std.mem.eql(u8, kind, "command-settled")) {
        if (object.count() != 4) return error.InvalidGatewayLine;
        const command_id = jsonString(object.get("commandId")) orelse return error.InvalidGatewayLine;
        const status = jsonString(object.get("status")) orelse return error.InvalidGatewayLine;
        if (command_id.len == 0 or command_id.len > 64 or (!std.mem.eql(u8, status, "succeeded") and !std.mem.eql(u8, status, "failed"))) return error.InvalidGatewayLine;
        return .event;
    }
    return error.InvalidGatewayLine;
}

pub const Options = struct {
    paths: PathOptions = .{},
    bridge_profile: BridgeProfile = .production,
    shutdown_grace_ms: u16 = 6000,
};

const State = enum {
    idle,
    running,
    faulted,
    stopping,
    stopped,
};

const Pending = struct {
    id: [native_sdk.bridge.max_id_bytes]u8,
    id_len: usize,
    responder: native_sdk.bridge.AsyncResponder,
    request: []u8,
    writer_active: bool = false,
    writer_done: bool = false,
    ui_done: bool = false,

    fn idSlice(self: *const Pending) []const u8 {
        return self.id[0..self.id_len];
    }
};

const Failure = struct {
    pending: *Pending,
    code: native_sdk.bridge.ErrorCode,
    message: []const u8,
};

const Response = struct {
    pending: *Pending,
    bytes: []u8,
};

const RendererEvent = struct {
    bytes: []u8,
};

const Action = union(enum) {
    response: Response,
    failure: Failure,
    event: RendererEvent,
    write_complete: *Pending,
};

/// Owns the private gateway process and all cross-thread queues.
///
/// Keep this value at a stable address from the first `dispatcher`/`start`
/// call until `stop` returns. Worker threads only enqueue owned bytes and call
/// the platform's thread-safe `wake`; Native SDK responders and renderer event
/// emission are exclusively drained by `onEvent` on `.effects_wake`.
pub const RuntimeHost = struct {
    allocator: std.mem.Allocator = std.heap.page_allocator,
    io: std.Io,
    parent_environment: *const std.process.Environ.Map,
    options: Options,

    mutex: std.Io.Mutex = .init,
    request_ready: std.Io.Condition = .init,
    event_space_ready: std.Io.Condition = .init,
    state: State = .idle,
    services: ?native_sdk.platform.PlatformServices = null,

    child: ?std.process.Child = null,
    writer_thread: ?std.Thread = null,
    reader_thread: ?std.Thread = null,
    writer_finished: std.atomic.Value(bool) = .init(false),
    reader_finished: std.atomic.Value(bool) = .init(false),
    reader_buffer: ?[]u8 = null,
    writer_buffer: ?[]u8 = null,

    handlers: [2]native_sdk.bridge.AsyncHandler = undefined,
    pending: [max_pending_requests]?*Pending = .{null} ** max_pending_requests,
    pending_count: usize = 0,
    requests: [max_pending_requests]?*Pending = .{null} ** max_pending_requests,
    request_head: usize = 0,
    request_len: usize = 0,
    actions: [max_actions]?Action = .{null} ** max_actions,
    action_head: usize = 0,
    action_len: usize = 0,
    queued_events: usize = 0,

    pub fn init(process_init: std.process.Init, options: Options) RuntimeHost {
        return .{
            .io = process_init.io,
            .parent_environment = process_init.environ_map,
            .options = options,
        };
    }

    pub fn dispatcher(self: *RuntimeHost) native_sdk.bridge.Dispatcher {
        self.handlers[0] = .{
            .name = snapshot_command,
            .context = self,
            .invoke_fn = invoke,
        };
        self.handlers[1] = .{
            .name = dispatch_command,
            .context = self,
            .invoke_fn = invoke,
        };
        return .{
            .policy = bridgePolicy(self.options.bridge_profile),
            .async_registry = .{ .handlers = &self.handlers },
        };
    }

    pub fn start(self: *RuntimeHost, runtime: *native_sdk.Runtime) !void {
        self.mutex.lockUncancelable(self.io);
        if (self.state != .idle) {
            self.mutex.unlock(self.io);
            return error.RuntimeHostAlreadyStarted;
        }
        self.services = runtime.options.platform.services;
        self.mutex.unlock(self.io);

        var paths = try resolveRuntimePaths(self.io, self.allocator, self.parent_environment, self.options.paths);
        defer paths.deinit(self.allocator);
        var environment = try buildSanitizedEnvironment(self.allocator, self.parent_environment, &paths);
        defer environment.deinit();

        self.reader_buffer = try self.allocator.alloc(u8, reader_buffer_bytes);
        errdefer {
            if (self.reader_buffer) |buffer| {
                self.allocator.free(buffer);
                self.reader_buffer = null;
            }
        }
        self.writer_buffer = try self.allocator.alloc(u8, writer_buffer_bytes);
        errdefer {
            if (self.writer_buffer) |buffer| {
                self.allocator.free(buffer);
                self.writer_buffer = null;
            }
        }

        var child = try std.process.spawn(self.io, .{
            .argv = &.{paths.gateway_path},
            .environ_map = &environment,
            .stdin = .pipe,
            .stdout = .pipe,
            .stderr = .inherit,
            .create_no_window = true,
        });
        var child_transferred = false;
        errdefer if (!child_transferred) child.kill(self.io);

        const stdin_file = child.stdin.?;
        const stdout_file = child.stdout.?;
        child.stdin = null;
        child.stdout = null;
        self.child = child;
        child_transferred = true;

        self.writer_finished.store(false, .release);
        self.reader_finished.store(false, .release);
        self.mutex.lockUncancelable(self.io);
        self.state = .running;
        self.mutex.unlock(self.io);

        self.writer_thread = std.Thread.spawn(.{}, writerMain, .{ self, stdin_file }) catch |err| {
            stdin_file.close(self.io);
            stdout_file.close(self.io);
            self.abortStart();
            return err;
        };
        self.reader_thread = std.Thread.spawn(.{}, readerMain, .{ self, stdout_file }) catch |err| {
            stdout_file.close(self.io);
            self.abortStart();
            return err;
        };
    }

    pub fn onEvent(self: *RuntimeHost, runtime: *native_sdk.Runtime, event: native_sdk.Event) void {
        if (event != .effects_wake) return;
        self.drain(runtime);
    }

    pub fn stop(self: *RuntimeHost, runtime: *native_sdk.Runtime) void {
        self.beginStopping("Runtime host is shutting down");

        const polls: usize = @max(1, @as(usize, self.options.shutdown_grace_ms) / @as(usize, shutdown_poll_ms));
        for (0..polls) |_| {
            if (self.writer_finished.load(.acquire) and self.reader_finished.load(.acquire)) break;
            std.Io.sleep(self.io, .fromMilliseconds(shutdown_poll_ms), .awake) catch break;
        }

        if (self.child) |*child| child.kill(self.io);
        if (self.writer_thread) |thread| thread.join();
        if (self.reader_thread) |thread| thread.join();
        self.writer_thread = null;
        self.reader_thread = null;
        self.child = null;

        self.drain(runtime);
        if (self.reader_buffer) |buffer| self.allocator.free(buffer);
        if (self.writer_buffer) |buffer| self.allocator.free(buffer);
        self.reader_buffer = null;
        self.writer_buffer = null;

        self.mutex.lockUncancelable(self.io);
        self.state = .stopped;
        self.services = null;
        self.mutex.unlock(self.io);
    }

    fn abortStart(self: *RuntimeHost) void {
        self.beginStopping("Runtime host failed to start");
        if (self.child) |*child| child.kill(self.io);
        if (self.writer_thread) |thread| thread.join();
        if (self.writer_thread == null) self.writer_finished.store(true, .release);
        self.reader_finished.store(true, .release);
        self.writer_thread = null;
        self.child = null;
        if (self.reader_buffer) |buffer| self.allocator.free(buffer);
        if (self.writer_buffer) |buffer| self.allocator.free(buffer);
        self.reader_buffer = null;
        self.writer_buffer = null;
    }

    fn invoke(
        context: *anyopaque,
        invocation: native_sdk.bridge.Invocation,
        responder: native_sdk.bridge.AsyncResponder,
    ) anyerror!void {
        const self: *RuntimeHost = @ptrCast(@alignCast(context));
        const request = encodeRequest(
            self.allocator,
            invocation.request.id,
            invocation.request.command,
            invocation.request.payload,
        ) catch |err| {
            const code: native_sdk.bridge.ErrorCode = switch (err) {
                error.InvalidRequestId, error.InvalidJson => .invalid_request,
                error.MessageTooLarge => .payload_too_large,
                error.OutOfMemory => .internal_error,
            };
            respondError(responder, invocation.request.id, code, @errorName(err));
            return;
        };
        errdefer self.allocator.free(request);

        const pending = self.allocator.create(Pending) catch {
            respondError(responder, invocation.request.id, .internal_error, "OutOfMemory");
            return;
        };
        errdefer self.allocator.destroy(pending);
        pending.* = .{
            .id = undefined,
            .id_len = invocation.request.id.len,
            .responder = responder,
            .request = request,
        };
        @memcpy(pending.id[0..pending.id_len], invocation.request.id);

        const Rejection = struct {
            code: native_sdk.bridge.ErrorCode,
            message: []const u8,
        };
        var rejection: ?Rejection = null;
        self.mutex.lockUncancelable(self.io);
        if (self.state != .running) {
            rejection = .{ .code = .handler_failed, .message = "Runtime host is unavailable" };
        } else if (self.pending_count == max_pending_requests or self.request_len == max_pending_requests) {
            rejection = .{ .code = .handler_failed, .message = "Runtime request queue is full" };
        } else if (self.findPendingLocked(invocation.request.id) != null) {
            rejection = .{ .code = .invalid_request, .message = "Runtime request id is already pending" };
        }
        if (rejection) |failure| {
            self.mutex.unlock(self.io);
            self.allocator.free(request);
            self.allocator.destroy(pending);
            respondError(responder, invocation.request.id, failure.code, failure.message);
            return;
        }

        self.insertPendingLocked(pending) catch unreachable;
        const request_index = (self.request_head + self.request_len) % self.requests.len;
        self.requests[request_index] = pending;
        self.request_len += 1;
        self.request_ready.signal(self.io);
        self.mutex.unlock(self.io);
    }

    fn writerMain(self: *RuntimeHost, file: std.Io.File) void {
        defer self.writer_finished.store(true, .release);
        defer file.close(self.io);
        var writer = file.writerStreaming(self.io, self.writer_buffer.?);

        while (true) {
            self.mutex.lockUncancelable(self.io);
            while (self.request_len == 0 and self.state == .running) {
                self.request_ready.waitUncancelable(self.io, &self.mutex);
            }
            if (self.request_len == 0) {
                self.mutex.unlock(self.io);
                return;
            }
            const pending = self.requests[self.request_head].?;
            self.requests[self.request_head] = null;
            self.request_head = (self.request_head + 1) % self.requests.len;
            self.request_len -= 1;
            pending.writer_active = true;
            self.mutex.unlock(self.io);

            writer.interface.writeAll(pending.request) catch {
                self.transportFault("Runtime gateway stdin failed");
                self.queueWriteComplete(pending);
                return;
            };
            writer.interface.flush() catch {
                self.transportFault("Runtime gateway stdin failed");
                self.queueWriteComplete(pending);
                return;
            };
            self.queueWriteComplete(pending);
        }
    }

    fn readerMain(self: *RuntimeHost, file: std.Io.File) void {
        defer self.reader_finished.store(true, .release);
        defer file.close(self.io);
        var reader = file.readerStreaming(self.io, self.reader_buffer.?);

        while (true) {
            const maybe_line = reader.interface.takeDelimiter('\n') catch {
                self.transportFault("Runtime gateway stdout failed");
                return;
            };
            const line = maybe_line orelse {
                self.transportFault("Runtime gateway exited");
                return;
            };
            const kind = classifyLine(self.allocator, line) catch {
                self.transportFault("Runtime gateway emitted malformed JSONL");
                return;
            };

            switch (kind) {
                .response => |response| {
                    const bytes = self.allocator.dupe(u8, line) catch {
                        self.transportFault("Runtime response allocation failed");
                        return;
                    };
                    self.mutex.lockUncancelable(self.io);
                    const pending = self.takePendingLocked(response.id[0..response.id_len]) orelse {
                        self.mutex.unlock(self.io);
                        self.allocator.free(bytes);
                        self.transportFault("Runtime gateway returned an unknown request id");
                        return;
                    };
                    const queued = self.pushActionLocked(.{ .response = .{ .pending = pending, .bytes = bytes } });
                    self.mutex.unlock(self.io);
                    if (!queued) {
                        self.allocator.free(bytes);
                        self.transportFault("Runtime completion queue is full");
                        return;
                    }
                    self.wake();
                },
                .event => {
                    const bytes = self.allocator.dupe(u8, line) catch {
                        self.transportFault("Runtime event allocation failed");
                        return;
                    };
                    self.queueRendererEvent(bytes) catch {
                        self.transportFault("Runtime event queue failed");
                        return;
                    };
                },
            }
        }
    }

    /// Takes ownership of bytes. Recorder events are non-durable notifications,
    /// so none may be dropped or replaced; the reader waits for UI queue space.
    fn queueRendererEvent(self: *RuntimeHost, bytes: []u8) !void {
        var owned_bytes: ?[]u8 = bytes;
        defer if (owned_bytes) |remaining| self.allocator.free(remaining);

        while (true) {
            self.mutex.lockUncancelable(self.io);
            if (self.queued_events < max_queued_events) {
                const queued = self.pushActionLocked(.{ .event = .{ .bytes = bytes } });
                if (!queued) {
                    self.mutex.unlock(self.io);
                    return error.ActionQueueFull;
                }
                self.queued_events += 1;
                owned_bytes = null;
                self.mutex.unlock(self.io);
                self.wake();
                return;
            }
            if (self.state != .running) {
                self.mutex.unlock(self.io);
                return error.RuntimeHostUnavailable;
            }
            self.event_space_ready.waitUncancelable(self.io, &self.mutex);
            self.mutex.unlock(self.io);
        }
    }

    fn queueWriteComplete(self: *RuntimeHost, pending: *Pending) void {
        self.mutex.lockUncancelable(self.io);
        const queued = self.pushActionLocked(.{ .write_complete = pending });
        self.mutex.unlock(self.io);
        if (queued) self.wake();
    }

    fn transportFault(self: *RuntimeHost, message: []const u8) void {
        self.mutex.lockUncancelable(self.io);
        if (self.state != .running) {
            self.mutex.unlock(self.io);
            return;
        }
        self.state = .faulted;
        self.failAllPendingLocked(message);
        self.request_ready.broadcast(self.io);
        self.event_space_ready.broadcast(self.io);
        self.mutex.unlock(self.io);
        self.wake();
    }

    fn beginStopping(self: *RuntimeHost, message: []const u8) void {
        self.mutex.lockUncancelable(self.io);
        switch (self.state) {
            .running, .faulted => {
                self.state = .stopping;
                self.failAllPendingLocked(message);
                self.request_ready.broadcast(self.io);
                self.event_space_ready.broadcast(self.io);
            },
            .idle => self.state = .stopping,
            .stopping, .stopped => {},
        }
        self.mutex.unlock(self.io);
        self.wake();
    }

    fn failAllPendingLocked(self: *RuntimeHost, message: []const u8) void {
        for (&self.pending) |*slot| {
            const pending = slot.* orelse continue;
            slot.* = null;
            self.pending_count -= 1;
            if (!pending.writer_active) pending.writer_done = true;
            _ = self.pushActionLocked(.{ .failure = .{
                .pending = pending,
                .code = .handler_failed,
                .message = message,
            } });
        }
        for (&self.requests) |*slot| slot.* = null;
        self.request_head = 0;
        self.request_len = 0;
    }

    fn drain(self: *RuntimeHost, runtime: *native_sdk.Runtime) void {
        while (true) {
            self.mutex.lockUncancelable(self.io);
            const action = self.popActionLocked();
            self.mutex.unlock(self.io);
            const next = action orelse return;

            switch (next) {
                .response => |response| {
                    response.pending.responder.respond(response.bytes) catch {};
                    self.allocator.free(response.bytes);
                    response.pending.ui_done = true;
                    self.releasePendingIfDone(response.pending);
                },
                .failure => |failure| {
                    respondError(failure.pending.responder, failure.pending.idSlice(), failure.code, failure.message);
                    failure.pending.ui_done = true;
                    self.releasePendingIfDone(failure.pending);
                },
                .event => |renderer_value| {
                    runtime.emitWindowEvent(main_window_id, renderer_event, renderer_value.bytes) catch {};
                    self.allocator.free(renderer_value.bytes);
                },
                .write_complete => |pending| {
                    pending.writer_done = true;
                    self.releasePendingIfDone(pending);
                },
            }
        }
    }

    fn releasePendingIfDone(self: *RuntimeHost, pending: *Pending) void {
        if (!pending.writer_done or !pending.ui_done) return;
        self.allocator.free(pending.request);
        self.allocator.destroy(pending);
    }

    fn wake(self: *RuntimeHost) void {
        const services = self.services orelse return;
        services.wake() catch {};
    }

    fn insertPendingLocked(self: *RuntimeHost, pending: *Pending) !void {
        for (&self.pending) |*slot| {
            if (slot.* == null) {
                slot.* = pending;
                self.pending_count += 1;
                return;
            }
        }
        return error.PendingQueueFull;
    }

    fn findPendingLocked(self: *RuntimeHost, id: []const u8) ?*Pending {
        for (self.pending) |slot| {
            const pending = slot orelse continue;
            if (std.mem.eql(u8, pending.idSlice(), id)) return pending;
        }
        return null;
    }

    fn takePendingLocked(self: *RuntimeHost, id: []const u8) ?*Pending {
        for (&self.pending) |*slot| {
            const pending = slot.* orelse continue;
            if (!std.mem.eql(u8, pending.idSlice(), id)) continue;
            slot.* = null;
            self.pending_count -= 1;
            return pending;
        }
        return null;
    }

    fn pushActionLocked(self: *RuntimeHost, action: Action) bool {
        if (self.action_len == self.actions.len) return false;
        const index = (self.action_head + self.action_len) % self.actions.len;
        self.actions[index] = action;
        self.action_len += 1;
        return true;
    }

    fn popActionLocked(self: *RuntimeHost) ?Action {
        if (self.action_len == 0) return null;
        const action = self.actions[self.action_head].?;
        self.actions[self.action_head] = null;
        self.action_head = (self.action_head + 1) % self.actions.len;
        self.action_len -= 1;
        if (action == .event) {
            self.queued_events -= 1;
            self.event_space_ready.signal(self.io);
        }
        return action;
    }
};

fn respondError(
    responder: native_sdk.bridge.AsyncResponder,
    id: []const u8,
    code: native_sdk.bridge.ErrorCode,
    message: []const u8,
) void {
    var response: [1024]u8 = undefined;
    const encoded = native_sdk.bridge.writeErrorResponse(&response, id, code, message);
    responder.respond(encoded) catch {};
}

test "packaged paths ignore development sidecar overrides" {
    var parent: std.process.Environ.Map = .init(std.testing.allocator);
    defer parent.deinit();
    try parent.put("ATET_GATEWAY_PATH", "/tmp/untrusted/atet-gateway");
    try parent.put("ATET_CAPTURE_HELPER", "/tmp/untrusted/atet-capture");
    try parent.put("ATET_FACE_ANALYZER", "/tmp/untrusted/atet-face-analyzer");

    var paths = try resolveRuntimePathsForExecutable(
        std.testing.allocator,
        &parent,
        .{
            .runtime_root = "/tmp/explicit/runtime",
            .gateway_path = "/tmp/explicit/atet-gateway",
            .capture_helper_path = "/tmp/explicit/atet-capture",
            .face_analyzer_path = "/tmp/explicit/atet-face-analyzer",
        },
        "/Applications/Atet.app/Contents/MacOS/atet",
    );
    defer paths.deinit(std.testing.allocator);

    try std.testing.expectEqualStrings("/Applications/Atet.app/Contents/Resources/runtime", paths.runtime_root);
    try std.testing.expectEqualStrings("/Applications/Atet.app/Contents/Resources/runtime/bin/atet-gateway", paths.gateway_path);
    try std.testing.expectEqualStrings("/Applications/Atet.app/Contents/Resources/runtime/bin/atet-capture", paths.capture_helper_path);
    try std.testing.expectEqualStrings("/Applications/Atet.app/Contents/Resources/runtime/bin/atet-face-analyzer", paths.face_analyzer_path);
}

test "development paths require and honor absolute sidecars" {
    var parent: std.process.Environ.Map = .init(std.testing.allocator);
    defer parent.deinit();
    try parent.put("ATET_GATEWAY_PATH", "/tmp/atet-runtime/bin/atet-gateway");
    try parent.put("ATET_CAPTURE_HELPER", "/tmp/atet-capture");
    try parent.put("ATET_FACE_ANALYZER", "/tmp/atet-face-analyzer");

    var paths = try resolveRuntimePathsForExecutable(
        std.testing.allocator,
        &parent,
        .{},
        "/tmp/zig-cache/atet",
    );
    defer paths.deinit(std.testing.allocator);

    try std.testing.expectEqualStrings("/tmp/atet-runtime", paths.runtime_root);
    try std.testing.expectEqualStrings("/tmp/atet-runtime/bin/atet-gateway", paths.gateway_path);
    try std.testing.expectEqualStrings("/tmp/atet-capture", paths.capture_helper_path);
    try std.testing.expectEqualStrings("/tmp/atet-face-analyzer", paths.face_analyzer_path);
    try std.testing.expectError(
        error.MissingDevelopmentRuntimeRoot,
        resolveRuntimePathsForExecutable(std.testing.allocator, &.{}, .{}, "/tmp/zig-cache/atet"),
    );
}

test "sanitized environment carries only trusted runtime configuration" {
    var parent: std.process.Environ.Map = .init(std.testing.allocator);
    defer parent.deinit();
    try parent.put("HOME", "/Users/example");
    try parent.put("ATET_REPOSITORY_ROOT", "/work/atet-project");
    try parent.put("OPENAI_API_KEY", "secret");
    try parent.put("HTTPS_PROXY", "http://proxy.invalid");
    try parent.put("DYLD_INSERT_LIBRARIES", "/tmp/evil.dylib");
    try parent.put("BUN_OPTIONS", "--preload=/tmp/evil.js");

    var paths = try runtimePathsFromRoot(std.testing.allocator, "/opt/atet/runtime", .{});
    defer paths.deinit(std.testing.allocator);
    var environment = try buildSanitizedEnvironment(std.testing.allocator, &parent, &paths);
    defer environment.deinit();

    try std.testing.expectEqualStrings("/Users/example", environment.get("HOME").?);
    try std.testing.expectEqualStrings("/tmp", environment.get("TMPDIR").?);
    try std.testing.expectEqualStrings("en_US.UTF-8", environment.get("LANG").?);
    try std.testing.expectEqualStrings("/work/atet-project", environment.get("ATET_REPOSITORY_ROOT").?);
    try std.testing.expectEqualStrings("/opt/atet/runtime/bin/atet-capture", environment.get("ATET_CAPTURE_HELPER").?);
    try std.testing.expectEqualStrings("/opt/atet/runtime/bin/atet-face-analyzer", environment.get("ATET_FACE_ANALYZER").?);
    try std.testing.expect(environment.get("OPENAI_API_KEY") == null);
    try std.testing.expect(environment.get("HTTPS_PROXY") == null);
    try std.testing.expect(environment.get("DYLD_INSERT_LIBRARIES") == null);
    try std.testing.expect(environment.get("BUN_OPTIONS") == null);
}

test "bridge profiles keep command and navigation origins aligned" {
    try std.testing.expectEqual(BridgeProfile.production, BridgeProfile.fromBuild(false, false));
    try std.testing.expectEqual(BridgeProfile.development, BridgeProfile.fromBuild(true, false));
    try std.testing.expectEqual(BridgeProfile.automation, BridgeProfile.fromBuild(false, true));
    try std.testing.expectEqual(@as(usize, 1), BridgeProfile.production.origins().len);
    try std.testing.expectEqual(@as(usize, 2), BridgeProfile.development.origins().len);
}

test "gateway codec preserves JSON values and exact command names" {
    const encoded = try encodeRequest(
        std.testing.allocator,
        "bridge-42",
        snapshot_command,
        "{\"protocol\":\"atet.desktop\"}",
    );
    defer std.testing.allocator.free(encoded);
    try std.testing.expectEqualStrings(
        "{\"id\":\"bridge-42\",\"command\":\"atet.runtime.snapshot\",\"payload\":{\"protocol\":\"atet.desktop\"}}\n",
        encoded,
    );
}

test "gateway classifier separates strict responses and desktop events" {
    const response = try classifyLine(
        std.testing.allocator,
        "{\"id\":\"bridge-42\",\"ok\":true,\"result\":{\"ok\":true}}",
    );
    try std.testing.expect(response == .response);
    try std.testing.expectEqualStrings("bridge-42", response.response.id[0..response.response.id_len]);

    try std.testing.expect((try classifyLine(
        std.testing.allocator,
        "{\"kind\":\"snapshot-changed\",\"protocolVersion\":3,\"snapshot\":{}}",
    )) == .event);
    try std.testing.expect((try classifyLine(
        std.testing.allocator,
        "{\"commandId\":\"command_gateway01\",\"kind\":\"command-settled\",\"protocolVersion\":3,\"status\":\"failed\"}",
    )) == .event);
    try std.testing.expectError(
        error.InvalidGatewayLine,
        classifyLine(
            std.testing.allocator,
            "{\"commandId\":\"command_fixture001\",\"kind\":\"command-settled\",\"protocolVersion\":2,\"status\":\"succeeded\"}",
        ),
    );
    try std.testing.expectError(
        error.InvalidGatewayLine,
        classifyLine(
            std.testing.allocator,
            "{\"commandId\":\"command_fixture001\",\"extra\":true,\"kind\":\"command-settled\",\"protocolVersion\":3,\"status\":\"succeeded\"}",
        ),
    );
    try std.testing.expectError(
        error.InvalidGatewayLine,
        classifyLine(std.testing.allocator, "{\"kind\":\"unknown\",\"protocolVersion\":3}"),
    );
}
