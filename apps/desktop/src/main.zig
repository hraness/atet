const std = @import("std");
const builtin = @import("builtin");
const build_options = @import("build_options");
const runner = @import("runner");
const native_sdk = @import("native_sdk");
const runtime_host = @import("runtime_host.zig");

pub const panic = std.debug.FullPanic(native_sdk.debug.capturePanic);

const app_slug = "atet";
const display_name = "Atet";
const bundle_id = "com.hraness.atet";

const App = struct {
    env_map: *std.process.Environ.Map,
    runtime_host: runtime_host.RuntimeHost,

    fn app(self: *@This()) native_sdk.App {
        return .{
            .context = self,
            .name = app_slug,
            .source = native_sdk.frontend.productionSource(.{ .dist = "frontend/dist" }),
            .source_fn = source,
            .start_fn = start,
            .event_fn = event,
            .stop_fn = stop,
        };
    }

    fn source(context: *anyopaque) anyerror!native_sdk.WebViewSource {
        const self: *@This() = @ptrCast(@alignCast(context));
        return native_sdk.frontend.sourceFromEnv(self.env_map, .{
            .dist = "frontend/dist",
            .entry = "index.html",
        });
    }

    fn start(context: *anyopaque, runtime: *native_sdk.Runtime) anyerror!void {
        const self: *@This() = @ptrCast(@alignCast(context));
        try self.runtime_host.start(runtime);
    }

    fn event(context: *anyopaque, runtime: *native_sdk.Runtime, value: native_sdk.Event) anyerror!void {
        const self: *@This() = @ptrCast(@alignCast(context));
        self.runtime_host.onEvent(runtime, value);
    }

    fn stop(context: *anyopaque, runtime: *native_sdk.Runtime) anyerror!void {
        const self: *@This() = @ptrCast(@alignCast(context));
        self.runtime_host.stop(runtime);
    }
};

pub fn main(init: std.process.Init) !void {
    const bridge_profile = runtime_host.BridgeProfile.fromBuild(
        builtin.mode == .Debug,
        build_options.automation,
    );
    var app = App{
        .env_map = init.environ_map,
        .runtime_host = runtime_host.RuntimeHost.init(init, .{ .bridge_profile = bridge_profile }),
    };
    try runner.runWithOptions(app.app(), .{
        .app_name = display_name,
        .window_title = display_name,
        .bundle_id = bundle_id,
        .icon_path = "assets/icon.png",
        .bridge = app.runtime_host.dispatcher(),
        .security = .{
            .navigation = .{ .allowed_origins = bridge_profile.origins() },
        },
    }, init);
}

test "application identity is stable" {
    try std.testing.expectEqualStrings("atet", app_slug);
    try std.testing.expectEqualStrings("Atet", display_name);
    try std.testing.expectEqualStrings("com.hraness.atet", bundle_id);
    try std.testing.expectEqualStrings("15.0", build_options.minimum_macos_version);
}
