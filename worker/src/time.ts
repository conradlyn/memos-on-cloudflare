/**
 * Timestamp helpers for the Memos v1 REST API.
 *
 * The v1 API is the JSON mapping of Memos' protobuf definitions, so timestamps
 * must follow proto3 JSON rules (RFC 3339). The reference implementation (Go +
 * protojson) emits whole seconds and drops the fractional part entirely, e.g.
 * `2026-08-02T01:11:30Z` — never `2026-08-02T01:11:30.000Z`.
 *
 * This is not cosmetic. Native clients decode the payload with
 * swift-openapi-runtime, whose default `dateTranscoder` is
 * `ISO8601DateTranscoder()` built from a bare `ISO8601DateFormatter()`
 * (formatOptions = [.withInternetDateTime]). That formatter returns nil for any
 * string carrying fractional seconds, and the transcoder turns nil into
 * `DecodingError.dataCorrupted`, surfacing in apps as
 * "The data couldn't be read because it isn't in the correct format."
 *
 * Verified locally:
 *   ISO8601DateFormatter().date(from: "2026-08-02T01:11:30.000Z") == nil
 *   ISO8601DateFormatter().date(from: "2026-08-02T01:11:30Z")     == 2026-08-02 01:11:30 +0000
 *
 * So every `date-time` value we hand to a native client goes through here.
 */

const PROTO_EPOCH = "1970-01-01T00:00:00Z";

/** Formats a Unix timestamp (seconds) as proto3-JSON RFC 3339, whole seconds. */
export function protoTimestamp(seconds: number): string {
  if (!Number.isFinite(seconds)) {
    return PROTO_EPOCH;
  }
  // Date#toISOString always yields `...sssZ`; strip the milliseconds.
  return new Date(Math.trunc(seconds) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Formats a Unix timestamp (milliseconds) as proto3-JSON RFC 3339, whole seconds. */
export function protoTimestampFromMs(milliseconds: number): string {
  return protoTimestamp(milliseconds / 1000);
}

/** Normalizes any date string we may have stored into proto3-JSON RFC 3339. */
export function protoTimestampFromISOString(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value;
  }
  return protoTimestampFromMs(parsed);
}
