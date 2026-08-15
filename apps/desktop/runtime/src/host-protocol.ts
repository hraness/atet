import { z } from "zod";
import { DesktopEventSchema } from "../../contracts";

export const runtimeSnapshotCommand = "atet.runtime.snapshot" as const;
export const runtimeDispatchCommand = "atet.runtime.dispatch" as const;
export const MAX_HOST_LINE_BYTES = 64 * 1024;
export const MAX_PENDING_HOST_REQUESTS = 16;

const HostRequestIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9._:-]+$/u);

export const HostRequestSchema = z.strictObject({
  command: z.enum([runtimeSnapshotCommand, runtimeDispatchCommand]),
  id: HostRequestIdSchema,
  payload: z.unknown(),
});

export const HostResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ id: HostRequestIdSchema, ok: z.literal(true), result: z.unknown() }),
  z.strictObject({
    error: z.strictObject({
      code: z.enum(["conflict", "internal_error", "invalid_request", "unavailable"]),
      message: z.string().min(1).max(2_048),
    }),
    id: z.string().max(64),
    ok: z.literal(false),
  }),
]);

export type HostRequest = Readonly<z.infer<typeof HostRequestSchema>>;
export type HostResponse = Readonly<z.infer<typeof HostResponseSchema>>;
export type HostErrorCode = Extract<HostResponse, { readonly ok: false }>["error"]["code"];

export function parseHostRequest(value: unknown): HostRequest {
  return HostRequestSchema.parse(value);
}

export function hostSuccess(id: string, result: unknown): HostResponse {
  return HostResponseSchema.parse({ id, ok: true, result });
}

export function hostFailure(id: string, code: HostErrorCode, message: string): HostResponse {
  return HostResponseSchema.parse({ error: { code, message }, id, ok: false });
}

export function encodeHostResponse(response: HostResponse): string {
  const line = `${JSON.stringify(HostResponseSchema.parse(response))}\n`;
  if (Buffer.byteLength(line) > MAX_HOST_LINE_BYTES) {
    throw new Error("Host response exceeded the JSONL bound.");
  }
  return line;
}

export function encodeHostEvent(event: unknown): string {
  const line = `${JSON.stringify(DesktopEventSchema.parse(event))}\n`;
  if (Buffer.byteLength(line) > MAX_HOST_LINE_BYTES) {
    throw new Error("Host event exceeded the JSONL bound.");
  }
  return line;
}
