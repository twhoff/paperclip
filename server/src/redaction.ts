import {
  CompiledSensitiveValueMatchers,
  SensitiveValueStreamRedactor,
} from "@paperclipai/adapter-utils/server-utils";

const SECRET_PAYLOAD_KEY_RE =
  /(api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)/i;
const JWT_VALUE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/;
export const REDACTED_EVENT_VALUE = "***REDACTED***";
const MAX_REDACTION_DEPTH = 32;
const MAX_REDACTION_NODES = 4_096;
const MAX_COLLECTED_SECRET_VALUES = 128;
const MAX_COLLECTED_SECRET_BYTES = 1024 * 1024;
const JWT_IN_TEXT_RE = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+/g;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  try {
    if (Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  } catch {
    return false;
  }
}

export function isSensitivePayloadKey(key: string) {
  return SECRET_PAYLOAD_KEY_RE.test(key);
}

export interface SensitivePayloadValueCollection {
  values: string[];
  overflow: boolean;
}

export function collectSensitivePayloadValues(value: unknown): SensitivePayloadValueCollection {
  const values = new Set<string>();
  const active = new WeakSet<object>();
  let nodes = 0;
  let collectedBytes = 0;
  let overflow = false;

  function collect(entry: unknown, sensitiveKey: boolean, depth: number) {
    if (depth >= MAX_REDACTION_DEPTH || nodes >= MAX_REDACTION_NODES) {
      overflow = true;
      return;
    }
    nodes += 1;
    if (typeof entry === "string") {
      if (sensitiveKey && entry.length > 0) {
        if (values.has(entry)) return;
        if (values.size >= MAX_COLLECTED_SECRET_VALUES) {
          overflow = true;
          return;
        }
        const remainingBytes = MAX_COLLECTED_SECRET_BYTES - collectedBytes;
        if (entry.length > remainingBytes) {
          overflow = true;
          return;
        }
        const entryBytes = Buffer.byteLength(entry, "utf8");
        if (entryBytes > remainingBytes) {
          overflow = true;
          return;
        }
        values.add(entry);
        collectedBytes += entryBytes;
      }
      return;
    }
    if (typeof entry !== "object" || entry === null || active.has(entry)) return;
    if (sensitiveKey && isSecretRefBinding(entry)) return;
    if (sensitiveKey && isPlainBinding(entry)) {
      const bindingValue = readOwnDataProperty(entry, "value");
      if (!bindingValue.ok) {
        overflow = true;
        return;
      }
      collect(bindingValue.value, true, depth + 1);
      return;
    }
    let arrayEntry: boolean;
    try {
      arrayEntry = Array.isArray(entry);
    } catch {
      overflow = true;
      return;
    }
    active.add(entry);
    if (arrayEntry) {
      const arrayValue = entry as unknown[];
      try {
        const length = arrayValue.length;
        for (let index = 0; index < length; index += 1) {
          if (nodes >= MAX_REDACTION_NODES) {
            overflow = true;
            break;
          }
          collect(arrayValue[index], sensitiveKey, depth + 1);
        }
      } catch {
        overflow = true;
      } finally {
        active.delete(entry);
      }
      return;
    }
    let proto: object | null;
    try {
      proto = Object.getPrototypeOf(entry);
    } catch {
      overflow = true;
      active.delete(entry);
      return;
    }
    if (proto !== Object.prototype && proto !== null) {
      active.delete(entry);
      return;
    }
    const record = entry as Record<string, unknown>;
    try {
      for (const key in record) {
        if (nodes >= MAX_REDACTION_NODES) {
          overflow = true;
          break;
        }
        if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
        let nested: unknown;
        try {
          nested = record[key];
        } catch {
          overflow = true;
          continue;
        }
        collect(nested, sensitiveKey || isSensitivePayloadKey(key), depth + 1);
      }
    } catch {
      overflow = true;
    } finally {
      active.delete(entry);
    }
  }

  collect(value, false, 0);
  return { values: Array.from(values), overflow };
}

function readOwnDataProperty(
  value: object,
  key: string,
): { ok: true; exists: boolean; value: unknown } | { ok: false } {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return { ok: true, exists: false, value: undefined };
    if (!("value" in descriptor)) return { ok: false };
    return { ok: true, exists: true, value: descriptor.value };
  } catch {
    return { ok: false };
  }
}

function isSecretRefBinding(value: unknown): value is { type: "secret_ref"; secretId: string; version?: unknown } {
  if (!isPlainObject(value)) return false;
  const type = readOwnDataProperty(value, "type");
  const secretId = readOwnDataProperty(value, "secretId");
  return type.ok && type.exists && type.value === "secret_ref" &&
    secretId.ok && secretId.exists && typeof secretId.value === "string";
}

function isPlainBinding(value: unknown): value is { type: "plain"; value: unknown } {
  if (!isPlainObject(value)) return false;
  const type = readOwnDataProperty(value, "type");
  const bindingValue = readOwnDataProperty(value, "value");
  return type.ok && type.exists && type.value === "plain" &&
    bindingValue.ok && bindingValue.exists;
}

interface SanitizationState {
  active: WeakSet<object>;
  exhausted: boolean;
  nodes: number;
  stringBytes: number;
}

function defineSafeProperty(target: Record<string, unknown>, key: string, value: unknown) {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function consumeStringBudget(value: string, state: SanitizationState) {
  const remaining = MAX_COLLECTED_SECRET_BYTES - state.stringBytes;
  if (value.length > remaining) {
    state.exhausted = true;
    return false;
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > remaining) {
    state.exhausted = true;
    return false;
  }
  state.stringBytes += bytes;
  return true;
}

function sanitizeBoundedValue(
  value: unknown,
  state: SanitizationState,
  depth: number,
): unknown {
  if (state.exhausted) return REDACTED_EVENT_VALUE;
  if (depth >= MAX_REDACTION_DEPTH || state.nodes >= MAX_REDACTION_NODES) {
    state.exhausted = true;
    return REDACTED_EVENT_VALUE;
  }
  state.nodes += 1;

  if (typeof value === "string") {
    if (!consumeStringBudget(value, state)) return REDACTED_EVENT_VALUE;
    return JWT_VALUE_RE.test(value)
      ? REDACTED_EVENT_VALUE
      : value.replace(JWT_IN_TEXT_RE, REDACTED_EVENT_VALUE);
  }
  if (value === null || value === undefined || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))) {
    return value;
  }
  if (typeof value !== "object") return REDACTED_EVENT_VALUE;
  if (state.active.has(value)) return REDACTED_EVENT_VALUE;

  let arrayValue: boolean;
  try {
    arrayValue = Array.isArray(value);
  } catch {
    state.exhausted = true;
    return REDACTED_EVENT_VALUE;
  }
  if (arrayValue) {
    const input = value as unknown[];
    let length: number;
    try {
      length = input.length;
    } catch {
      state.exhausted = true;
      return REDACTED_EVENT_VALUE;
    }
    if (length > MAX_REDACTION_NODES - state.nodes) {
      state.exhausted = true;
      return REDACTED_EVENT_VALUE;
    }
    const output: unknown[] = [];
    state.active.add(value);
    try {
      for (let index = 0; index < length; index += 1) {
        let entry: unknown;
        try {
          const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
          entry = descriptor && "value" in descriptor
            ? descriptor.value
            : descriptor
              ? REDACTED_EVENT_VALUE
              : null;
        } catch {
          state.exhausted = true;
          return REDACTED_EVENT_VALUE;
        }
        output.push(sanitizeBoundedValue(entry, state, depth + 1));
      }
    } finally {
      state.active.delete(value);
    }
    return output;
  }

  let prototype: object | null;
  let keys: string[];
  try {
    prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return REDACTED_EVENT_VALUE;
    keys = Object.keys(value);
  } catch {
    state.exhausted = true;
    return REDACTED_EVENT_VALUE;
  }
  if (keys.length > MAX_REDACTION_NODES - state.nodes) {
    state.exhausted = true;
    return REDACTED_EVENT_VALUE;
  }

  const output = Object.create(prototype === null ? null : Object.prototype) as Record<string, unknown>;
  state.active.add(value);
  try {
    for (const key of keys) {
      if (!consumeStringBudget(key, state)) break;
      const property = readOwnDataProperty(value, key);
      if (!property.ok || !property.exists) {
        defineSafeProperty(output, key, REDACTED_EVENT_VALUE);
        continue;
      }
      const entry = property.value;
      if (isSecretRefBinding(entry)) {
        const secretId = readOwnDataProperty(entry, "secretId");
        const version = readOwnDataProperty(entry, "version");
        if (!secretId.ok || !secretId.exists || typeof secretId.value !== "string" ||
          !consumeStringBudget(secretId.value, state)) {
          defineSafeProperty(output, key, REDACTED_EVENT_VALUE);
          continue;
        }
        const binding: Record<string, unknown> = {
          type: "secret_ref",
          secretId: secretId.value,
        };
        if (version.ok && version.exists) {
          binding.version = sanitizeBoundedValue(version.value, state, depth + 1);
        }
        defineSafeProperty(output, key, binding);
        continue;
      }
      if (isPlainBinding(entry)) {
        defineSafeProperty(output, key, { type: "plain", value: REDACTED_EVENT_VALUE });
        continue;
      }
      if (isSensitivePayloadKey(key)) {
        defineSafeProperty(output, key, REDACTED_EVENT_VALUE);
        continue;
      }
      defineSafeProperty(output, key, sanitizeBoundedValue(entry, state, depth + 1));
    }
  } finally {
    state.active.delete(value);
  }
  return output;
}

type SanitizedStringSlot =
  | { kind: "key"; target: Record<string, unknown>; key: string; value: string }
  | { kind: "value"; target: Record<string, unknown> | unknown[]; key: string | number; value: string };

function collectSanitizedStringSlots(value: unknown) {
  const slots: SanitizedStringSlot[] = [];
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0 && nodes < MAX_REDACTION_NODES) {
    const current = pending.pop()!;
    if (current.depth >= MAX_REDACTION_DEPTH || typeof current.value !== "object" ||
      current.value === null) continue;
    nodes += 1;
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        const entry = current.value[index];
        if (typeof entry === "string") {
          slots.push({ kind: "value", target: current.value, key: index, value: entry });
        } else {
          pending.push({ value: entry, depth: current.depth + 1 });
        }
      }
      continue;
    }
    const record = current.value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      slots.push({ kind: "key", target: record, key, value: key });
      const entry = record[key];
      if (typeof entry === "string") {
        slots.push({ kind: "value", target: record, key, value: entry });
      } else {
        pending.push({ value: entry, depth: current.depth + 1 });
      }
    }
  }
  return slots;
}

function redactKnownSecrets(value: string, matchers: CompiledSensitiveValueMatchers) {
  const redactor = new SensitiveValueStreamRedactor(matchers, REDACTED_EVENT_VALUE);
  return `${redactor.push(value)}${redactor.flush()}`;
}

function hasPlausibleJwtContinuation(value: string, allValues: readonly string[]) {
  if (value.endsWith("ey")) {
    return allValues.some((candidate) => candidate !== value && candidate.startsWith("J"));
  }
  if (!value.endsWith("e")) return false;
  return allValues.some((candidate) => candidate !== value && candidate.startsWith("yJ")) ||
    (allValues.some((candidate) => candidate !== value && candidate === "y") &&
      allValues.some((candidate) => candidate !== value && candidate.startsWith("J")));
}

function redactJwtFragments(value: string, allValues: readonly string[]) {
  let redacted = JWT_VALUE_RE.test(value)
    ? REDACTED_EVENT_VALUE
    : value.replace(JWT_IN_TEXT_RE, REDACTED_EVENT_VALUE);
  const trailing = redacted.match(/(?:^|[^A-Za-z0-9_-])(eyJ[A-Za-z0-9_.-]*)$/);
  if (trailing?.[1]) {
    redacted = `${redacted.slice(0, redacted.length - trailing[1].length)}${REDACTED_EVENT_VALUE}`;
  } else if ((redacted.endsWith("e") || redacted.endsWith("ey")) &&
    hasPlausibleJwtContinuation(redacted, allValues)) {
    redacted = `${redacted.slice(0, redacted.endsWith("ey") ? -2 : -1)}${REDACTED_EVENT_VALUE}`;
  }
  return redacted;
}

function applyCrossFieldRedaction(
  value: Record<string, unknown>,
  sensitiveValues: readonly string[],
) {
  const matchers = new CompiledSensitiveValueMatchers(sensitiveValues);
  if (matchers.overflow) return { redacted: REDACTED_EVENT_VALUE };
  const slots = collectSanitizedStringSlots(value);
  const allValues = slots.map((slot) => slot.value);
  for (const slot of slots.filter((entry) => entry.kind === "value")) {
    const redacted = redactJwtFragments(redactKnownSecrets(slot.value, matchers), allValues);
    if (redacted === slot.value) continue;
    if (Array.isArray(slot.target) && typeof slot.key === "number") {
      slot.target[slot.key] = redacted;
    } else if (!Array.isArray(slot.target) && typeof slot.key === "string") {
      defineSafeProperty(slot.target, slot.key, redacted);
    }
  }
  for (const slot of slots.filter((entry) => entry.kind === "key")) {
    const redacted = redactJwtFragments(redactKnownSecrets(slot.value, matchers), allValues);
    if (redacted === slot.value) continue;
    const current = slot.target[slot.key];
    delete slot.target[slot.key];
    defineSafeProperty(slot.target, redacted, current);
  }
  return value;
}

export function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  const sensitive = collectSensitivePayloadValues(record);
  if (sensitive.overflow) return { redacted: REDACTED_EVENT_VALUE };
  const state: SanitizationState = {
    active: new WeakSet(),
    exhausted: false,
    nodes: 0,
    stringBytes: 0,
  };
  const sanitized = sanitizeBoundedValue(record, state, 0);
  if (!isPlainObject(sanitized)) return { redacted: REDACTED_EVENT_VALUE };
  return applyCrossFieldRedaction(sanitized, sensitive.values);
}

export function redactEventPayload(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!payload) return null;
  if (!isPlainObject(payload)) return { redacted: REDACTED_EVENT_VALUE };
  return sanitizeRecord(payload);
}
