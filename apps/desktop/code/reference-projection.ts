import { ApplicationError } from "../application/errors";
import type {
  JsonValue,
  SerializedRefV1,
} from "./contracts";

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function isJsonRecord(
  value: JsonValue,
): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !isJsonArray(value);
}

export function projectReferenceValue(
  reference: SerializedRefV1,
  value: JsonValue,
): JsonValue {
  let projected = value;
  for (const segment of reference.$ref.path ?? []) {
    if (typeof segment === "number") {
      if (
        !isJsonArray(projected)
        || !Number.isSafeInteger(segment)
        || segment < 0
        || segment >= projected.length
        || !Object.hasOwn(projected, segment)
      ) {
        throw new ApplicationError(
          "invalid-data",
          `Reference ${reference.$ref.nodeKey} has an invalid array projection at ${String(segment)}.`,
        );
      }
      const item = projected[segment];
      if (item === undefined) {
        throw new ApplicationError(
          "invalid-data",
          `Reference ${reference.$ref.nodeKey} projects an absent array item.`,
        );
      }
      projected = item;
      continue;
    }
    if (!isJsonRecord(projected) || !Object.hasOwn(projected, segment)) {
      throw new ApplicationError(
        "invalid-data",
        `Reference ${reference.$ref.nodeKey} has an invalid field projection at ${segment}.`,
      );
    }
    const item = projected[segment];
    if (item === undefined) {
      throw new ApplicationError(
        "invalid-data",
        `Reference ${reference.$ref.nodeKey} projects an absent field.`,
      );
    }
    projected = item;
  }
  return projected;
}
