import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import z from "@deepseek-ai/schemastery";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { LlmAdapter, LlmError, fileHandleText, offloadedImageText, requestImageHandleText, resolveRetryPolicy, textOnlyImageText } from "@deepseek-ai/dsh-llm";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
//#region src/shared/constants.ts
const PLUGIN_ID = "dsh-codebuddy-llm";
/** Settings namespace the host installs (rc cores) and the namespace model discovery is offered under. */
const SETTINGS_NS = "llm-codebuddy";
//#endregion
//#region src/host/config/constants.ts
const DEFAULT_MODEL_ID = "default";
const DEFAULT_CONTEXT_WINDOW = 2e5;
/**
* CodeBuddy 默认模型 `deepseek-v4.1-flash` 的真实窗口。
*
* 读自 CLI 的模型元数据：`contextWindow: 1,000,000` / `maxTokens: 384,000`。
* 窗口报小了 dsh 会提前触发压缩，把还能用的历史压掉。
*/
const CODEBUDDY_CONTEXT_WINDOW = 1e6;
/**
* CodeBuddy 的默认模型。
*
* 和 `dsh-codebuddy`（子智能体版）保持一致：两边锁同一个模型，
* 才不会出现「同一个 CodeBuddy，当模型时是 A、当子代理时是 B」。
*/
const DEFAULT_CODEBUDDY_MODEL = "deepseek-v4.1-flash";
/**
* 找一个**真正的 node.exe**。
*
* 绝对不能回落到 `process.execPath`：dsh 桌面端里那是 `DeepSeek Harness.exe`，
* 拿它跑 JS 脚本的后果是「退出码 0、stdout 为空」，而且没有任何报错。
* 这一条在 `dsh-codebuddy` 上已经踩过一次，别再来一次。
*/
function findNode() {
	return [
		join(process.env.LOCALAPPDATA ?? "", "pnpm", "node.exe"),
		join(process.env.ProgramFiles ?? "C:\\Program Files", "nodejs", "node.exe"),
		"C:\\Program Files\\nodejs\\node.exe"
	].find((candidate) => candidate.length > 0 && existsSync(candidate));
}
/** CodeBuddy CLI 的入口脚本（JS，需要用 node 去跑）。 */
function findCli() {
	const local = process.env.LOCALAPPDATA ?? "";
	return [join(local, "pnpm", "node_modules", "@tencent-ai", "codebuddy-code", "bin", "codebuddy"), join(local, "npm", "node_modules", "@tencent-ai", "codebuddy-code", "bin", "codebuddy")].find((candidate) => candidate.length > 0 && existsSync(candidate));
}
/**
* 开箱即用的 CodeBuddy 路由：`agents` 为空时自动挂上。
*
* 为什么给默认值而不是要求手写配置：这个插件的用途就是「把本机 CodeBuddy 接成模型」，
* 装完不能直接用就等于没装。显式配了 `agents` 之后默认值自动让位。
*
* `command` 用 node 而不是 `codebuddy`：bin 是无扩展名的 JS + shebang，
* Windows 上直接 spawn 会失败；走 `node <js>` 才是可移植的。
*/
function defaultCodeBuddyProfile() {
	const node = findNode();
	const cli = findCli();
	if (node === void 0 || cli === void 0) return void 0;
	return {
		displayName: "CodeBuddy",
		command: node,
		args: [
			cli,
			"--acp",
			"--acp-transport",
			"stdio",
			"--permission-mode",
			"dontAsk",
			"--model",
			DEFAULT_CODEBUDDY_MODEL
		],
		env: { CODEBUDDY_MAIN_AGENT_ALLOW_UNOPTED: "1" },
		envMode: "whitelist",
		models: [],
		discoverModels: true,
		permission: "allow",
		imageInput: "auto",
		systemPrompt: "drop",
		showToolCalls: true,
		contextWindow: CODEBUDDY_CONTEXT_WINDOW,
		startupTimeoutMs: 6e4,
		idleTimeoutMs: 18e4
	};
}
//#endregion
//#region src/host/config/schema.ts
const DEFAULT_IDLE_TIMEOUT_MS = 18e4;
const DEFAULT_STARTUP_TIMEOUT_MS = 6e4;
const AcpModelProfile = z.object({
	id: z.string().required(),
	name: z.string(),
	description: z.string(),
	contextWindow: z.natural()
});
const AcpAgentProfile = z.object({
	displayName: z.string(),
	command: z.string().required(),
	args: z.array(z.string()).default([]),
	env: z.dict(z.string()).default({}),
	envMode: z.union(["whitelist", "inherit"]).default("whitelist"),
	cwd: z.string(),
	authMethod: z.string(),
	models: z.array(AcpModelProfile).default([]),
	discoverModels: z.boolean().default(true),
	permission: z.union([
		"ask",
		"allow",
		"read-only",
		"reject"
	]).default("ask"),
	imageInput: z.union([
		"auto",
		"force",
		"off"
	]).default("auto"),
	systemPrompt: z.union(["drop", "forward"]).default("drop"),
	showToolCalls: z.boolean().default(true),
	contextWindow: z.natural().default(DEFAULT_CONTEXT_WINDOW),
	startupTimeoutMs: z.natural().default(DEFAULT_STARTUP_TIMEOUT_MS),
	idleTimeoutMs: z.natural().default(DEFAULT_IDLE_TIMEOUT_MS)
});
const Config = z.object({ agents: z.dict(AcpAgentProfile).default({}).volatile() });
/** Read the agents of a resolved config; a cell from another schemastery copy is read the same way. */
function agentsOf(config) {
	const agents = config?.agents;
	if (agents === void 0) return builtInDefault();
	const resolved = typeof agents.get === "function" ? agents.get() : agents;
	return Object.keys(resolved).length === 0 ? builtInDefault() : resolved;
}
/** 默认 CodeBuddy 路由；本机找不到 node 或 CLI 时给空（让配置页面去报错，而不是静默失败）。 */
function builtInDefault() {
	const profile = defaultCodeBuddyProfile();
	return profile === void 0 ? {} : { codebuddy: profile };
}
//#endregion
//#region node_modules/@agentclientprotocol/sdk/dist/schema/index.js
const AGENT_METHODS = {
	initialize: "initialize",
	authenticate: "authenticate",
	providers_list: "providers/list",
	providers_set: "providers/set",
	providers_disable: "providers/disable",
	session_new: "session/new",
	session_load: "session/load",
	session_set_mode: "session/set_mode",
	session_set_config_option: "session/set_config_option",
	session_prompt: "session/prompt",
	session_cancel: "session/cancel",
	mcp_message: "mcp/message",
	session_list: "session/list",
	session_delete: "session/delete",
	session_fork: "session/fork",
	session_resume: "session/resume",
	session_close: "session/close",
	logout: "logout",
	nes_start: "nes/start",
	nes_suggest: "nes/suggest",
	nes_accept: "nes/accept",
	nes_reject: "nes/reject",
	nes_close: "nes/close",
	document_did_open: "document/didOpen",
	document_did_change: "document/didChange",
	document_did_close: "document/didClose",
	document_did_save: "document/didSave",
	document_did_focus: "document/didFocus"
};
const CLIENT_METHODS = {
	session_request_permission: "session/request_permission",
	session_update: "session/update",
	fs_write_text_file: "fs/write_text_file",
	fs_read_text_file: "fs/read_text_file",
	terminal_create: "terminal/create",
	terminal_output: "terminal/output",
	terminal_release: "terminal/release",
	terminal_wait_for_exit: "terminal/wait_for_exit",
	terminal_kill: "terminal/kill",
	mcp_connect: "mcp/connect",
	mcp_message: "mcp/message",
	mcp_disconnect: "mcp/disconnect",
	elicitation_create: "elicitation/create",
	elicitation_complete: "elicitation/complete"
};
const PROTOCOL_METHODS = { cancel_request: "$/cancel_request" };
//#endregion
//#region node_modules/zod/v4/core/util.js
function getEnumValues(entries) {
	const numericValues = Object.values(entries).filter((v) => typeof v === "number");
	return Object.entries(entries).filter(([k, _]) => numericValues.indexOf(+k) === -1).map(([_, v]) => v);
}
function joinValues(array, separator = "|") {
	return array.map((val) => stringifyPrimitive(val)).join(separator);
}
function jsonStringifyReplacer(_, value) {
	if (typeof value === "bigint") return value.toString();
	return value;
}
var Cached = class {
	constructor(getter) {
		this._getter = getter;
		this._value = void 0;
	}
	get value() {
		const getter = this._getter;
		if (getter !== void 0) {
			this._value = getter();
			this._getter = void 0;
		}
		return this._value;
	}
};
function cached(getter) {
	return new Cached(getter);
}
function nullish(input) {
	return input === null || input === void 0;
}
function cleanRegex(source) {
	const start = source.startsWith("^") ? 1 : 0;
	const end = source.endsWith("$") ? source.length - 1 : source.length;
	return source.slice(start, end);
}
function floatSafeRemainder(val, step) {
	const ratio = val / step;
	const roundedRatio = Math.round(ratio);
	const tolerance = 4 * Number.EPSILON * Math.max(Math.abs(ratio), 1);
	if (Math.abs(ratio - roundedRatio) < tolerance) return 0;
	return ratio - roundedRatio;
}
function assignProp(target, prop, value) {
	Object.defineProperty(target, prop, {
		value,
		writable: true,
		enumerable: true,
		configurable: true
	});
}
/**
* Whichever object a def's `shape` currently answers from: the one the caller passed until the first read, the frozen copy after it.
*
* Its keys and descriptors read without invoking anything, which is what lets a discriminated union check its discriminator, and the cycle walk read a shape, without resolving a getter that references the schema being constructed. A def that answers `shape` from an accessor of its own has none.
*/
function rawShape(def) {
	const desc = Object.getOwnPropertyDescriptor(def, "shape");
	return desc?.get ? desc.get.raw : desc?.value;
}
function sourceShape(schema) {
	return rawShape(schema._zod.def) ?? schema._zod.def.shape;
}
function deferProp(target, key, getter) {
	Object.defineProperty(target, key, {
		get() {
			const value = getter();
			assignProp(this, key, value);
			return value;
		},
		enumerable: true,
		configurable: true
	});
}
function putProp(target, key, value) {
	if (key in target) assignProp(target, key, value);
	else target[key] = value;
}
/**
* Copies `keys` of `source`'s shape onto `target`, each value passed through `wrap`.
*
* A key the source has resolved is copied through now, so the derived shape states it outright and nothing has to resolve it to learn what it holds. A key the source still defers stays deferred, and reads back through the source's own `shape`, so it resolves once and both shapes get that one schema.
*/
function mirrorShape(target, source, keys, wrap) {
	const raw = sourceShape(source);
	for (const key of keys) {
		const desc = Object.getOwnPropertyDescriptor(raw, key);
		if (!desc.enumerable) continue;
		if (desc.get) deferProp(target, key, () => {
			const value = source._zod.def.shape[key];
			return wrap ? wrap(value, key) : value;
		});
		else putProp(target, key, wrap ? wrap(desc.value, key) : desc.value);
	}
}
function mirrorProps(target, source) {
	for (const key of Reflect.ownKeys(source)) {
		const desc = Object.getOwnPropertyDescriptor(source, key);
		if (!desc.enumerable) continue;
		if (desc.get) deferProp(target, key, () => source[key]);
		else putProp(target, key, desc.value);
	}
}
function mergeDefs(...defs) {
	const mergedDescriptors = {};
	for (const def of defs) Object.assign(mergedDescriptors, Object.getOwnPropertyDescriptors(def));
	return Object.defineProperties({}, mergedDescriptors);
}
function esc(str) {
	return JSON.stringify(str);
}
function slugify(input) {
	return input.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "");
}
const captureStackTrace = "captureStackTrace" in Error ? Error.captureStackTrace : (..._args) => {};
function isObject(data) {
	return typeof data === "object" && data !== null && !Array.isArray(data);
}
const allowsEval = /* @__PURE__ */ cached(() => {
	if (globalConfig.jitless) return false;
	if (typeof navigator !== "undefined" && navigator?.userAgent?.includes("Cloudflare")) return false;
	try {
		new Function("");
		return true;
	} catch (_) {
		return false;
	}
});
function isPlainObject(o) {
	if (isObject(o) === false) return false;
	const ctor = o.constructor;
	if (ctor === void 0) return true;
	if (typeof ctor !== "function") return true;
	const prot = ctor.prototype;
	if (isObject(prot) === false) return false;
	if (Object.prototype.hasOwnProperty.call(prot, "isPrototypeOf") === false) return false;
	return true;
}
function shallowClone(o) {
	if (isPlainObject(o)) return { ...o };
	if (Array.isArray(o)) return [...o];
	if (o instanceof Map) return new Map(o);
	if (o instanceof Set) return new Set(o);
	return o;
}
const propertyKeyTypes = /* @__PURE__ */ new Set([
	"string",
	"number",
	"symbol"
]);
function escapeRegex(str) {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function clone(inst, def, params) {
	const cl = new inst._zod.constr(def ?? inst._zod.def);
	if (!def || params?.parent) cl._zod.parent = inst;
	return cl;
}
function normalizeParams(_params) {
	const params = _params;
	if (!params) return {};
	if (typeof params === "string") return { error: () => params };
	if (params?.message !== void 0) {
		if (params?.error !== void 0) throw new Error("Cannot specify both `message` and `error` params");
		params.error = params.message;
	}
	delete params.message;
	if (typeof params.error === "string") return {
		...params,
		error: () => params.error
	};
	return params;
}
function stringifyPrimitive(value) {
	if (typeof value === "bigint") return value.toString() + "n";
	if (typeof value === "string") return `"${value}"`;
	return `${value}`;
}
function optionalKeys(shape) {
	return Object.keys(shape).filter((k) => {
		return shape[k]._zod.optin !== void 0 && shape[k]._zod.optout === "optional";
	});
}
const NUMBER_FORMAT_RANGES = {
	safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
	int32: [-2147483648, 2147483647],
	uint32: [0, 4294967295],
	float32: [-34028234663852886e22, 34028234663852886e22],
	float64: [-Number.MAX_VALUE, Number.MAX_VALUE]
};
const BIGINT_FORMAT_RANGES = {
	int64: [/* @__PURE__ */ BigInt("-9223372036854775808"), /* @__PURE__ */ BigInt("9223372036854775807")],
	uint64: [/* @__PURE__ */ BigInt(0), /* @__PURE__ */ BigInt("18446744073709551615")]
};
function pick$1(schema, mask) {
	const currDef = schema._zod.def;
	const checks = currDef.checks;
	if (checks && checks.length > 0) throw new Error(".pick() cannot be used on object schemas containing refinements");
	const newShape = {};
	mirrorShape(newShape, schema, maskedKeys(schema, mask));
	return clone(schema, mergeDefs(currDef, {
		shape: newShape,
		checks: []
	}));
}
function maskedKeys(schema, mask) {
	const raw = sourceShape(schema);
	const keys = [];
	for (const key of Reflect.ownKeys(mask)) {
		if (!Object.getOwnPropertyDescriptor(raw, key)?.enumerable) throw new Error(`Unrecognized key: "${String(key)}"`);
		if (mask[key]) keys.push(key);
	}
	return keys;
}
function omit(schema, mask) {
	const currDef = schema._zod.def;
	const checks = currDef.checks;
	if (checks && checks.length > 0) throw new Error(".omit() cannot be used on object schemas containing refinements");
	const omitted = new Set(maskedKeys(schema, mask));
	const newShape = {};
	mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)).filter((key) => !omitted.has(key)));
	return clone(schema, mergeDefs(currDef, {
		shape: newShape,
		checks: []
	}));
}
function extend(schema, shape) {
	if (!isPlainObject(shape)) throw new Error("Invalid input to extend: expected a plain object");
	const checks = schema._zod.def.checks;
	if (checks && checks.length > 0) {
		const existingShape = sourceShape(schema);
		for (const key of Reflect.ownKeys(shape)) if (Object.getOwnPropertyDescriptor(existingShape, key) !== void 0) throw new Error("Cannot overwrite keys on object schemas containing refinements. Use `.safeExtend()` instead.");
	}
	return clone(schema, mergeDefs(schema._zod.def, { shape: extended(schema, shape) }));
}
function extended(schema, shape) {
	const newShape = {};
	mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)));
	mirrorProps(newShape, shape);
	return newShape;
}
function safeExtend(schema, shape) {
	if (!isPlainObject(shape)) throw new Error("Invalid input to safeExtend: expected a plain object");
	return clone(schema, mergeDefs(schema._zod.def, { shape: extended(schema, shape) }));
}
function merge(a, b) {
	if (!b?._zod?.def) throw new Error("Invalid input to merge: expected an object schema. To merge a plain shape, use `.extend()`.");
	if (a._zod.def.checks?.length) throw new Error(".merge() cannot be used on object schemas containing refinements. Use .safeExtend() instead.");
	const newShape = {};
	mirrorShape(newShape, a, Reflect.ownKeys(sourceShape(a)));
	mirrorShape(newShape, b, Reflect.ownKeys(sourceShape(b)));
	return clone(a, mergeDefs(a._zod.def, {
		shape: newShape,
		get catchall() {
			return b._zod.def.catchall;
		},
		checks: b._zod.def.checks ?? []
	}));
}
function partial(Class, schema, mask, name = "partial") {
	const checks = schema._zod.def.checks;
	if (checks && checks.length > 0) throw new Error(`.${name}() cannot be used on object schemas containing refinements`);
	const selected = mask ? new Set(maskedKeys(schema, mask)) : void 0;
	const newShape = {};
	mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)), Class && ((value, key) => selected && !selected.has(key) ? value : new Class({
		type: "optional",
		innerType: value
	})));
	return clone(schema, mergeDefs(schema._zod.def, {
		shape: newShape,
		checks: []
	}));
}
function required(Class, schema, mask) {
	const selected = mask ? new Set(maskedKeys(schema, mask)) : void 0;
	const newShape = {};
	mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)), (value, key) => selected && !selected.has(key) ? value : new Class({
		type: "nonoptional",
		innerType: value
	}));
	return clone(schema, mergeDefs(schema._zod.def, { shape: newShape }));
}
function aborted(x, startIndex = 0) {
	if (x.aborted === true) return true;
	for (let i = startIndex; i < x.issues.length; i++) if (x.issues[i]?.continue !== true) return true;
	return false;
}
function explicitlyAborted(x, startIndex = 0) {
	if (x.aborted === true) return true;
	for (let i = startIndex; i < x.issues.length; i++) if (x.issues[i]?.continue === false) return true;
	return false;
}
function prefixIssues(path, issues) {
	return issues.map((iss) => {
		var _a;
		(_a = iss).path ?? (_a.path = []);
		iss.path.unshift(path);
		return iss;
	});
}
function unwrapMessage(message) {
	return typeof message === "string" ? message : message?.message;
}
/** The leading size checks of `defChecks` that set an upper bound, each paired with it. */
function sizeCaps(defChecks) {
	const caps = [];
	for (const ch of defChecks ?? []) {
		const d = ch._zod.def;
		if (!/_(length|size)$|_equals$/.test(d.check)) break;
		const max = d.maximum ?? d.length ?? d.size;
		if (max >= 0) caps.push([max, ch]);
	}
	return caps;
}
function attachSchema(issues, start, inst) {
	var _a;
	for (let i = start; i < issues.length; i++) (_a = issues[i]).schema ?? (_a.schema = inst);
}
function finalizeIssue(iss, ctx, config) {
	var _a;
	const traits = iss.inst?._zod?.traits;
	if (traits?.has("$ZodType")) if (traits.has("$ZodCheck")) (_a = iss).schema ?? (_a.schema = iss.inst);
	else iss.schema = iss.inst;
	const schemaError = iss.schema !== iss.inst ? iss.schema?._zod.def?.error : void 0;
	const message = iss.message ? iss.message : unwrapMessage(iss.inst?._zod.def?.error?.(iss)) ?? unwrapMessage(schemaError?.(iss)) ?? unwrapMessage(ctx?.error?.(iss)) ?? unwrapMessage(config.customError?.(iss)) ?? unwrapMessage(config.localeError?.(iss)) ?? "Invalid input";
	const full = {};
	for (const k of Object.keys(iss)) {
		if (k === "inst" || k === "schema" || k === "continue" || k === "input" || k === "__proto__") continue;
		full[k] = iss[k];
	}
	full.path ?? (full.path = []);
	full.message = message;
	if (ctx?.reportInput) full.input = iss.input;
	return full;
}
const highSurrogate = /[\uD800-\uDBFF]/;
function codePointLength(str) {
	const units = str.length;
	if (!highSurrogate.test(str)) return units;
	let count = units;
	for (let i = 0; i < units - 1; i++) if ((str.charCodeAt(i) & 64512) === 55296 && (str.charCodeAt(i + 1) & 64512) === 56320) {
		count--;
		i++;
	}
	return count;
}
function getLengthableOrigin(input) {
	if (Array.isArray(input)) return "array";
	if (typeof input === "string") return "string";
	return "unknown";
}
function parsedType(data) {
	const t = typeof data;
	switch (t) {
		case "number": return Number.isNaN(data) ? "nan" : "number";
		case "object": {
			if (data === null) return "null";
			if (Array.isArray(data)) return "array";
			const obj = data;
			if (obj && Object.getPrototypeOf(obj) !== Object.prototype && "constructor" in obj && obj.constructor) return obj.constructor.name;
		}
	}
	return t;
}
function issue(...args) {
	const [iss, input, inst] = args;
	if (typeof iss === "string") return {
		message: iss,
		code: "custom",
		input,
		inst
	};
	return { ...iss };
}
/**
* Installs a trait's members on its prototype. Each value builds that member for the instance on first read; the built value shadows the accessor as an own property, so a detached `const { parse } = schema` keeps working.
*
* Call this from a `proto` initializer, which runs once per prototype — never per instance.
*/
function members(proto, table) {
	for (const key in table) {
		const desc = Object.getOwnPropertyDescriptor(table, key);
		if (desc.get) Object.defineProperty(proto, key, {
			...desc,
			enumerable: false
		});
		else defineBound(proto, key, desc.value);
	}
}
/** Shadows a prototype member with an own value, so a getter that builds from the instance runs once. */
function own(inst, key, value, enumerable = true) {
	Object.defineProperty(inst, key, {
		configurable: true,
		writable: true,
		enumerable,
		value
	});
	return value;
}
/** Like {@link own}, for a member that was never an own data property and has to stay out of `Object.keys`. */
function hide(inst, key, value) {
	return own(inst, key, value, false);
}
/** Adds members a table derives from the instance: each builds on first read and shadows as own data, and assignment shadows the same way, as when these were own properties. */
function derived(computes, table) {
	for (const key in computes) {
		const compute = computes[key];
		Object.defineProperty(table, key, {
			configurable: true,
			enumerable: true,
			get() {
				return own(this, key, compute(this));
			},
			set(value) {
				own(this, key, value);
			}
		});
	}
	return table;
}
function defineBound(proto, key, fn) {
	Object.defineProperty(proto, key, {
		configurable: true,
		get() {
			return this == null ? fn : own(this, key, fn.bind(this));
		},
		set(value) {
			own(this, key, value);
		}
	});
}
/** Returns the prototype to install on, or `undefined` if this group is already installed on it. */
function claim(inst, sentinel) {
	const proto = Object.getPrototypeOf(inst);
	return sentinel in proto ? void 0 : proto;
}
let installing;
let broke = false;
const breaker = {
	configurable: true,
	get() {
		broke = true;
	}
};
/**
* Installs a lazily-derived internal on the `_zod` prototype of `inst`'s
* constructor, computed from the internals object itself and cached there on
* first read. One accessor per constructor rather than one per instance.
*/
function defineLazyInternal(inst, key, compute) {
	const proto = Object.getPrototypeOf(inst._zod);
	if (key in proto && installing !== inst._zod) {
		installing = void 0;
		return;
	}
	installing = inst._zod;
	Object.defineProperty(proto, key, {
		configurable: true,
		get() {
			Object.defineProperty(this, key, breaker);
			const outer = broke;
			broke = false;
			try {
				const value = compute(this);
				if (broke) delete this[key];
				else Object.defineProperty(this, key, {
					configurable: true,
					writable: true,
					value
				});
				broke = broke || outer;
				return value;
			} catch (err) {
				delete this[key];
				broke = broke || outer;
				throw err;
			}
		},
		set(value) {
			Object.defineProperty(this, key, {
				configurable: true,
				writable: true,
				value
			});
		}
	});
}
/**
* Installs `key` on `inst`'s prototype, computed by `make` on first read and cached there as an own
* data property. One accessor per constructor rather than one per instance, because an own accessor
* puts every instance after the first into v8 dictionary mode. The key doubles as the sentinel.
*/
function installLazyProp(inst, key, make, enumerable) {
	const proto = claim(inst, key);
	if (!proto) return;
	Object.defineProperty(proto, key, {
		configurable: true,
		get() {
			const desc = {
				configurable: true,
				writable: true,
				enumerable,
				value: void 0
			};
			Object.defineProperty(this, key, desc);
			desc.value = make(this);
			Object.defineProperty(this, key, desc);
			return desc.value;
		},
		set(value) {
			Object.defineProperty(this, key, {
				configurable: true,
				writable: true,
				enumerable,
				value
			});
		}
	});
}
/** Marks the thunk `_catch` synthesises for a constant catch value. `Function.length` cannot tell that thunk from a user callback — rest and defaulted parameters both report arity 0 — and a user callback reads `ctx.error`, whose issues only finalize correctly against the caller's per-parse error map. Provenance can say what arity cannot. A plain string key rather than `Symbol.for`, whose call at module scope no bundler can prove pure — the same shape that anchored `urlCanParse` into every build. */
const CONSTANT_CATCH = "~constantCatch";
/** Wraps a constant catch value in a thunk tagged with {@link CONSTANT_CATCH}. */
function constantCatch(value) {
	const fn = () => value;
	fn[CONSTANT_CATCH] = true;
	return fn;
}
//#endregion
//#region node_modules/zod/v4/core/core.js
var _a$1;
/** A special constant with type `never` */
const NEVER = /* @__PURE__ */ Object.freeze({ status: "aborted" });
const _zodDesc = {
	value: void 0,
	enumerable: false
};
let _E = "captureStackTrace" in Error ? Error : null;
function newError(Definition) {
	const E = _E;
	if (E) {
		const saved = E.stackTraceLimit;
		if (typeof saved === "number") {
			try {
				E.stackTraceLimit = 0;
			} catch {
				_E = null;
				return new Definition();
			}
			try {
				return new Definition();
			} finally {
				E.stackTraceLimit = saved;
			}
		}
	}
	return new Definition();
}
function $constructor(name, initializer, proto, params) {
	const zodProto = {};
	function Internals(def) {
		this.def = def;
		this.constr = _;
		this.traits = /* @__PURE__ */ new Set();
	}
	Internals.prototype = zodProto;
	const protoMembers = proto;
	const initialized = protoMembers && /* @__PURE__ */ new WeakSet();
	function init(inst, def) {
		if (!inst._zod) {
			_zodDesc.value = new Internals(def);
			try {
				Object.defineProperty(inst, "_zod", _zodDesc);
			} finally {
				_zodDesc.value = void 0;
			}
		} else if (inst._zod.traits.has(name)) return;
		inst._zod.traits.add(name);
		initializer(inst, def);
		if (initialized) {
			const own = Object.getPrototypeOf(inst);
			const ctorProto = inst._zod.constr.prototype;
			let up = own;
			while (up && up !== ctorProto) up = Object.getPrototypeOf(up);
			const target = up ?? own;
			if (!initialized.has(target)) {
				initialized.add(target);
				members(target, protoMembers);
			}
		}
		const proto = _.prototype;
		for (const k in proto) {
			if (!Object.prototype.hasOwnProperty.call(proto, k)) continue;
			if (!(k in inst)) inst[k] = proto[k].bind(inst);
		}
	}
	const Parent = params?.Parent ?? Object;
	class Definition extends Parent {}
	Object.defineProperty(Definition, "name", { value: name });
	function _(def) {
		const inst = params?.Parent ? newError(Definition) : this;
		init(inst, def);
		const deferred = inst._zod.deferred;
		if (deferred) {
			for (const fn of deferred) fn();
			inst._zod.deferred = void 0;
		}
		const pp = globalThis.__zod_globalConfig?.postProcessor;
		if (pp) pp(inst);
		return inst;
	}
	Object.defineProperty(_, "init", { value: init });
	Object.defineProperty(_, Symbol.hasInstance, { value: (inst) => {
		if (params?.Parent && inst instanceof params.Parent) return true;
		return inst?._zod?.traits?.has(name);
	} });
	Object.defineProperty(_, "name", { value: name });
	return _;
}
var $ZodAsyncError = class extends Error {
	constructor() {
		super(`Encountered Promise during synchronous parse. Use .parseAsync() instead.`);
	}
};
var $ZodEncodeError = class extends Error {
	constructor(name) {
		super(`Encountered unidirectional transform during encode: ${name}`);
		this.name = "ZodEncodeError";
	}
};
(_a$1 = globalThis).__zod_globalConfig ?? (_a$1.__zod_globalConfig = {});
const globalConfig = globalThis.__zod_globalConfig;
function config(newConfig) {
	if (newConfig) Object.assign(globalConfig, newConfig);
	return globalConfig;
}
//#endregion
//#region node_modules/zod/v4/core/errors.js
function _getMessage() {
	const internals = this._zod;
	internals.message ?? (internals.message = JSON.stringify(internals.def, jsonStringifyReplacer, 2));
	return internals.message;
}
function _setMessage(value) {
	this._zod.message = value;
}
const _messageDesc = {
	get: _getMessage,
	set: _setMessage,
	enumerable: true,
	configurable: true
};
const _issuesDesc = {
	value: void 0,
	enumerable: false
};
const _installedToString = /* @__PURE__ */ new WeakSet([Object.prototype, Error.prototype]);
const initializer$1 = (inst, def) => {
	inst.name = "$ZodError";
	_issuesDesc.value = def;
	Object.defineProperty(inst, "issues", _issuesDesc);
	_issuesDesc.value = void 0;
	Object.defineProperty(inst, "message", _messageDesc);
	const proto = Object.getPrototypeOf(inst);
	if (!_installedToString.has(proto)) {
		_installedToString.add(proto);
		Object.defineProperty(proto, "toString", {
			configurable: true,
			enumerable: false,
			get() {
				const value = () => this.message;
				Object.defineProperty(this, "toString", {
					value,
					configurable: true,
					writable: true
				});
				return value;
			},
			set(value) {
				Object.defineProperty(this, "toString", {
					value,
					configurable: true,
					writable: true
				});
			}
		});
	}
};
const $ZodError = $constructor("$ZodError", initializer$1);
$constructor("$ZodError", initializer$1, void 0, { Parent: Error });
/** Get-or-create `obj[key]` as an own data property. A path segment naming an inherited member
* ("toString", "constructor") would otherwise read through to the prototype, and assigning
* "__proto__" would hit the setter instead of creating a key. */
function node(obj, key, make) {
	if (!Object.prototype.hasOwnProperty.call(obj, key)) if (key === "__proto__") Object.defineProperty(obj, key, {
		value: make(),
		writable: true,
		enumerable: true,
		configurable: true
	});
	else obj[key] = make();
	return obj[key];
}
function flattenError(error, mapper = (issue) => issue.message) {
	const fieldErrors = {};
	const formErrors = [];
	for (const sub of error.issues) if (sub.path.length > 0) node(fieldErrors, sub.path[0], () => []).push(mapper(sub));
	else formErrors.push(mapper(sub));
	return {
		formErrors,
		fieldErrors
	};
}
function formatError(error, mapper = (issue) => issue.message) {
	const fieldErrors = { _errors: [] };
	const processError = (error, path = []) => {
		for (const issue of error.issues) if (issue.code === "invalid_union" && issue.errors.length) issue.errors.map((issues) => processError({ issues }, [...path, ...issue.path]));
		else if (issue.code === "invalid_key") processError({ issues: issue.issues }, [...path, ...issue.path]);
		else if (issue.code === "invalid_element") processError({ issues: issue.issues }, [...path, ...issue.path]);
		else {
			const fullpath = [...path, ...issue.path];
			if (fullpath.length === 0) fieldErrors._errors.push(mapper(issue));
			else {
				let curr = fieldErrors;
				let i = 0;
				while (i < fullpath.length) {
					const el = fullpath[i];
					const terminal = i === fullpath.length - 1;
					if (el === "_errors") {
						if (terminal) curr._errors.push(mapper(issue));
						i++;
						continue;
					}
					if (!Object.prototype.hasOwnProperty.call(curr, el)) Object.defineProperty(curr, el, {
						value: { _errors: [] },
						enumerable: true,
						writable: true,
						configurable: true
					});
					const node = curr[el];
					if (terminal) node._errors.push(mapper(issue));
					curr = node;
					i++;
				}
			}
		}
	};
	processError(error);
	return fieldErrors;
}
//#endregion
//#region node_modules/zod/v4/core/parse.js
function finalizeParams(callee, params) {
	return {
		callee: params?.callee ?? callee,
		Err: params?.Err
	};
}
const _parse = (_Err) => {
	const fn = (schema, value, _ctx, _params) => {
		const ctx = _ctx ? {
			..._ctx,
			async: false
		} : { async: false };
		const result = schema._zod.run({
			value,
			issues: []
		}, ctx);
		if (result instanceof Promise) throw new $ZodAsyncError();
		if (result.issues.length) {
			const e = new (_params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
			captureStackTrace(e, _params?.callee ?? fn);
			throw e;
		}
		return result.value;
	};
	return fn;
};
const _parseAsync = (_Err) => {
	const fn = async (schema, value, _ctx, params) => {
		const ctx = _ctx ? {
			..._ctx,
			async: true
		} : { async: true };
		let result = schema._zod.run({
			value,
			issues: []
		}, ctx);
		if (result instanceof Promise) result = await result;
		if (result.issues.length) {
			const e = new (params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
			captureStackTrace(e, params?.callee ?? fn);
			throw e;
		}
		return result.value;
	};
	return fn;
};
const _safeParse = (_Err) => (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		async: false
	} : { async: false };
	const result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) throw new $ZodAsyncError();
	return result.issues.length ? failure$1(_Err, result.issues, ctx) : {
		success: true,
		data: result.value
	};
};
function failure$1(Err, issues, ctx) {
	let error;
	return {
		success: false,
		get error() {
			if (!error) {
				error = new Err(issues.map((iss) => finalizeIssue(iss, ctx, config())));
				issues = void 0;
				ctx = void 0;
			}
			return error;
		},
		set error(e) {
			error = e;
			issues = void 0;
			ctx = void 0;
		}
	};
}
const _safeParseAsync = (_Err) => async (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		async: true
	} : { async: true };
	let result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) result = await result;
	return result.issues.length ? failure$1(_Err, result.issues, ctx) : {
		success: true,
		data: result.value
	};
};
const COMPILE_INVALID = /* @__PURE__ */ Symbol.for("zod.compile.invalid");
const COMPILE_FALLBACK = /* @__PURE__ */ Symbol.for("zod.compile.fallback");
const validate = ((schema, value, _ctx) => {
	const validator = schema._zod.bag.validator;
	if (validator !== void 0) {
		if (validator(value) !== COMPILE_INVALID) return true;
		if (validator.definite === true && _ctx === void 0) return false;
	}
	return validateFallback(schema, value, _ctx);
});
function validateFallback(schema, value, _ctx) {
	const ctx = _ctx ? {
		..._ctx,
		async: false,
		abortEarly: true
	} : {
		async: false,
		abortEarly: true
	};
	const fallbackRun = schema._zod.bag.fallbackRun;
	let result;
	if (fallbackRun) {
		ctx[COMPILE_FALLBACK] = true;
		result = fallbackRun({
			value,
			issues: []
		}, ctx);
	} else result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) throw new $ZodAsyncError();
	return result.issues.length === 0;
}
const validateAsync$1 = async (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		async: true,
		abortEarly: true
	} : {
		async: true,
		abortEarly: true
	};
	let result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) result = await result;
	return result.issues.length === 0;
};
const _encode = (_Err) => {
	const parse = _parse(_Err);
	const fn = (schema, value, _ctx, _params) => {
		return parse(schema, value, _ctx ? {
			..._ctx,
			direction: "backward"
		} : { direction: "backward" }, finalizeParams(fn, _params));
	};
	return fn;
};
const _decode = (_Err) => {
	const parse = _parse(_Err);
	const fn = (schema, value, _ctx, _params) => {
		return parse(schema, value, _ctx, finalizeParams(fn, _params));
	};
	return fn;
};
const _encodeAsync = (_Err) => {
	const parseAsync = _parseAsync(_Err);
	const fn = async (schema, value, _ctx, _params) => {
		return await parseAsync(schema, value, _ctx ? {
			..._ctx,
			direction: "backward"
		} : { direction: "backward" }, finalizeParams(fn, _params));
	};
	return fn;
};
const _decodeAsync = (_Err) => {
	const parseAsync = _parseAsync(_Err);
	const fn = async (schema, value, _ctx, _params) => {
		return await parseAsync(schema, value, _ctx, finalizeParams(fn, _params));
	};
	return fn;
};
const _safeEncode = (_Err) => (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		direction: "backward"
	} : { direction: "backward" };
	return _safeParse(_Err)(schema, value, ctx);
};
const _safeDecode = (_Err) => (schema, value, _ctx) => {
	return _safeParse(_Err)(schema, value, _ctx);
};
const _safeEncodeAsync = (_Err) => async (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		direction: "backward"
	} : { direction: "backward" };
	return _safeParseAsync(_Err)(schema, value, ctx);
};
const _safeDecodeAsync = (_Err) => async (schema, value, _ctx) => {
	return _safeParseAsync(_Err)(schema, value, _ctx);
};
//#endregion
//#region node_modules/zod/v4/core/regexes.js
/**
* @deprecated CUID v1 is deprecated by its authors due to information leakage
* (timestamps embedded in the id). Use {@link cuid2} instead.
* See https://github.com/paralleldrive/cuid.
*/
const cuid = /^[cC][0-9a-z]{6,}$/;
const cuid2 = /^[0-9a-z]+$/;
const ulid = /^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$/;
const xid = /^[0-9a-vA-V]{20}$/;
const ksuid = /^[A-Za-z0-9]{27}$/;
const nanoid = /^[a-zA-Z0-9_-]{21}$/;
function nanoidOfLength(length) {
	return new RegExp(`^[a-zA-Z0-9_-]{${length}}$`);
}
/** ISO 8601-1 duration regex. Does not support the 8601-2 extensions like negative durations or fractional/negative components. */
const duration = /^P(?:(\d+W)|(?!.*W)(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+([.,]\d+)?S)?)?)$/;
/** A regex for any UUID-like identifier: 8-4-4-4-12 hex pattern */
const guid = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
/** Returns a regex for validating an RFC 9562/4122 UUID.
*
* @param version Optionally specify a version 1-8. If no version is specified, all versions are supported. */
const uuid = (version) => {
	if (!version) return /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
	return new RegExp(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-${version}[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`);
};
/** Practical email validation */
const email = /^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
const _emoji$1 = `^(?=[\\s\\S]*[\\p{Extended_Pictographic}\\p{Regional_Indicator}\\u20E3])[\\p{Extended_Pictographic}\\p{Emoji_Component}]+$`;
function emoji() {
	return new RegExp(_emoji$1, "u");
}
const ipv4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
const ipv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;
const cidrv4 = /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/([0-9]|[1-2][0-9]|3[0-2])$/;
const cidrv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
const base64 = /^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/;
const base64url = /^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$/;
const httpProtocol = /^https?$/;
const e164 = /^\+[1-9]\d{6,14}$/;
const dateSource = `(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))`;
/** Anchors a pattern source. The interpolation lives here rather than at the call site because
* esbuild will not drop a `@__PURE__` call whose own argument interpolates a variable, but it
* will drop `anchor(dateSource)`. Keeping it inline pinned `date` into every bundle. */
function anchor(source) {
	return new RegExp(`^${source}$`);
}
const date = /* @__PURE__ */ anchor(dateSource);
function timeSource(args) {
	const hhmm = `(?:[01]\\d|2[0-3]):[0-5]\\d`;
	return typeof args.precision === "number" ? args.precision === -1 ? `${hhmm}` : args.precision === 0 ? `${hhmm}:[0-5]\\d` : `${hhmm}:[0-5]\\d\\.\\d{${args.precision}}` : args.seconds ? `${hhmm}:[0-5]\\d(?:\\.\\d+)?` : `${hhmm}(?::[0-5]\\d(?:\\.\\d+)?)?`;
}
function time(args) {
	return new RegExp(`^${timeSource(args)}$`);
}
function datetime(args) {
	const opts = ["Z"];
	if (args.offset) opts.push(`([+-](?:[01]\\d|2[0-3]):[0-5]\\d)`);
	const qualified = `${timeSource({
		precision: args.precision,
		seconds: true
	})}(?:${opts.join("|")})`;
	const timeRegex = args.local ? `${qualified}|${timeSource({ precision: args.precision })}` : qualified;
	return new RegExp(`^${dateSource}T(?:${timeRegex})$`);
}
const anyString = /^[\s\S]{0,}$/;
const integer = /^-?\d+$/;
const number$1 = /^-?\d+(?:\.\d+)?$/;
const boolean$1 = /^(?:true|false)$/i;
const lowercase = /^[^A-Z]*$/;
const uppercase = /^[^a-z]*$/;
//#endregion
//#region node_modules/zod/v4/core/checks.js
const $ZodCheck = /* @__PURE__ */ $constructor("$ZodCheck", (inst, def) => {
	var _a;
	inst._zod ?? (inst._zod = {});
	inst._zod.def = def;
	(_a = inst._zod).onattach ?? (_a.onattach = []);
});
/** Default `when` for length-based checks: run only on non-nullish values with a `length`. */
const _whenHasLength = (payload) => {
	const val = payload.value;
	return !nullish(val) && val.length !== void 0;
};
const numericOriginMap = {
	number: "number",
	bigint: "bigint",
	object: "date"
};
const $ZodCheckLessThan = /* @__PURE__ */ $constructor("$ZodCheckLessThan", (inst, def) => {
	$ZodCheck.init(inst, def);
	const origin = numericOriginMap[typeof def.value];
	inst._zod.check = (payload) => {
		if (def.inclusive ? payload.value <= def.value : payload.value < def.value) return;
		payload.issues.push({
			origin: numericOriginMap[typeof payload.value] ?? origin,
			code: "too_big",
			maximum: typeof def.value === "object" ? def.value.getTime() : def.value,
			input: payload.value,
			inclusive: def.inclusive,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckGreaterThan = /* @__PURE__ */ $constructor("$ZodCheckGreaterThan", (inst, def) => {
	$ZodCheck.init(inst, def);
	const origin = numericOriginMap[typeof def.value];
	inst._zod.check = (payload) => {
		if (def.inclusive ? payload.value >= def.value : payload.value > def.value) return;
		payload.issues.push({
			origin: numericOriginMap[typeof payload.value] ?? origin,
			code: "too_small",
			minimum: typeof def.value === "object" ? def.value.getTime() : def.value,
			input: payload.value,
			inclusive: def.inclusive,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckMultipleOf = /* @__PURE__ */ $constructor("$ZodCheckMultipleOf", (inst, def) => {
	$ZodCheck.init(inst, def);
	inst._zod.check = (payload) => {
		if (typeof payload.value !== typeof def.value) throw new Error("Cannot mix number and bigint in multiple_of check.");
		if (typeof payload.value === "bigint" ? def.value !== BigInt(0) && payload.value % def.value === BigInt(0) : floatSafeRemainder(payload.value, def.value) === 0) return;
		payload.issues.push({
			origin: typeof payload.value,
			code: "not_multiple_of",
			divisor: def.value,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckNumberFormat = /* @__PURE__ */ $constructor("$ZodCheckNumberFormat", (inst, def) => {
	$ZodCheck.init(inst, def);
	def.format = def.format || "float64";
	const isInt = def.format?.includes("int");
	const origin = isInt ? "int" : "number";
	const [minimum, maximum] = NUMBER_FORMAT_RANGES[def.format];
	inst._zod.check = (payload) => {
		const input = payload.value;
		if (isInt) {
			if (!Number.isInteger(input)) {
				payload.issues.push({
					expected: origin,
					format: def.format,
					code: "invalid_type",
					continue: false,
					input,
					inst
				});
				return;
			}
			if (!Number.isSafeInteger(input)) {
				if (input > 0) payload.issues.push({
					input,
					code: "too_big",
					maximum: Number.MAX_SAFE_INTEGER,
					note: "Integers must be within the safe integer range.",
					inst,
					origin,
					inclusive: true,
					continue: !def.abort
				});
				else payload.issues.push({
					input,
					code: "too_small",
					minimum: Number.MIN_SAFE_INTEGER,
					note: "Integers must be within the safe integer range.",
					inst,
					origin,
					inclusive: true,
					continue: !def.abort
				});
				return;
			}
		}
		if (input < minimum) payload.issues.push({
			origin: "number",
			input,
			code: "too_small",
			minimum,
			inclusive: true,
			inst,
			continue: !def.abort
		});
		if (input > maximum) payload.issues.push({
			origin: "number",
			input,
			code: "too_big",
			maximum,
			inclusive: true,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckMaxLength = /* @__PURE__ */ $constructor("$ZodCheckMaxLength", (inst, def) => {
	var _a;
	$ZodCheck.init(inst, def);
	(_a = inst._zod.def).when ?? (_a.when = _whenHasLength);
	inst._zod.check = (payload) => {
		const input = payload.value;
		const units = input.length;
		if ((typeof input === "string" && units > def.maximum ? codePointLength(input) : units) <= def.maximum) return;
		const origin = getLengthableOrigin(input);
		payload.issues.push({
			origin,
			code: "too_big",
			maximum: def.maximum,
			inclusive: true,
			input,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckMinLength = /* @__PURE__ */ $constructor("$ZodCheckMinLength", (inst, def) => {
	var _a;
	$ZodCheck.init(inst, def);
	(_a = inst._zod.def).when ?? (_a.when = _whenHasLength);
	inst._zod.check = (payload) => {
		const input = payload.value;
		const units = input.length;
		if ((typeof input === "string" && units >= def.minimum && units < def.minimum * 2 ? codePointLength(input) : units) >= def.minimum) return;
		const origin = getLengthableOrigin(input);
		payload.issues.push({
			origin,
			code: "too_small",
			minimum: def.minimum,
			inclusive: true,
			input,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckLengthEquals = /* @__PURE__ */ $constructor("$ZodCheckLengthEquals", (inst, def) => {
	var _a;
	$ZodCheck.init(inst, def);
	(_a = inst._zod.def).when ?? (_a.when = _whenHasLength);
	inst._zod.check = (payload) => {
		const input = payload.value;
		const units = input.length;
		const length = typeof input === "string" && units >= def.length && units <= def.length * 2 ? codePointLength(input) : units;
		if (length === def.length) return;
		const origin = getLengthableOrigin(input);
		const tooBig = length > def.length;
		payload.issues.push({
			origin,
			...tooBig ? {
				code: "too_big",
				maximum: def.length
			} : {
				code: "too_small",
				minimum: def.length
			},
			inclusive: true,
			exact: true,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckStringFormat = /* @__PURE__ */ $constructor("$ZodCheckStringFormat", (inst, def) => {
	var _a, _b;
	$ZodCheck.init(inst, def);
	if (def.pattern) (_a = inst._zod).check ?? (_a.check = (payload) => {
		def.pattern.lastIndex = 0;
		if (def.pattern.test(payload.value)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: def.format,
			input: payload.value,
			...def.pattern ? { pattern: def.pattern.toString() } : {},
			inst,
			continue: !def.abort
		});
	});
	else (_b = inst._zod).check ?? (_b.check = () => {});
});
const $ZodCheckRegex = /* @__PURE__ */ $constructor("$ZodCheckRegex", (inst, def) => {
	$ZodCheckStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		def.pattern.lastIndex = 0;
		if (def.pattern.test(payload.value)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "regex",
			input: payload.value,
			pattern: def.pattern.toString(),
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckLowerCase = /* @__PURE__ */ $constructor("$ZodCheckLowerCase", (inst, def) => {
	def.pattern ?? (def.pattern = lowercase);
	$ZodCheckStringFormat.init(inst, def);
});
const $ZodCheckUpperCase = /* @__PURE__ */ $constructor("$ZodCheckUpperCase", (inst, def) => {
	def.pattern ?? (def.pattern = uppercase);
	$ZodCheckStringFormat.init(inst, def);
});
const $ZodCheckIncludes = /* @__PURE__ */ $constructor("$ZodCheckIncludes", (inst, def) => {
	$ZodCheck.init(inst, def);
	const escapedRegex = escapeRegex(def.includes);
	def.pattern = new RegExp(typeof def.position === "number" ? `^.{${def.position},}${escapedRegex}` : escapedRegex);
	inst._zod.check = (payload) => {
		if (payload.value.includes(def.includes, def.position)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "includes",
			includes: def.includes,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckStartsWith = /* @__PURE__ */ $constructor("$ZodCheckStartsWith", (inst, def) => {
	$ZodCheck.init(inst, def);
	const pattern = new RegExp(`^${escapeRegex(def.prefix)}.*`);
	def.pattern ?? (def.pattern = pattern);
	inst._zod.check = (payload) => {
		if (payload.value.startsWith(def.prefix)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "starts_with",
			prefix: def.prefix,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckEndsWith = /* @__PURE__ */ $constructor("$ZodCheckEndsWith", (inst, def) => {
	$ZodCheck.init(inst, def);
	const pattern = new RegExp(`.*${escapeRegex(def.suffix)}$`);
	def.pattern ?? (def.pattern = pattern);
	inst._zod.check = (payload) => {
		if (payload.value.endsWith(def.suffix)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "ends_with",
			suffix: def.suffix,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckOverwrite = /* @__PURE__ */ $constructor("$ZodCheckOverwrite", (inst, def) => {
	$ZodCheck.init(inst, def);
	inst._zod.check = (payload) => {
		payload.value = def.tx(payload.value);
	};
});
//#endregion
//#region node_modules/zod/v4/core/doc.js
var Doc = class {
	constructor(args = [], closed = {}) {
		this.content = [];
		this.indent = 0;
		this.args = args;
		this.closed = closed;
	}
	indented(fn) {
		this.indent += 1;
		try {
			fn(this);
		} finally {
			this.indent -= 1;
		}
	}
	write(arg) {
		if (typeof arg === "function") {
			arg(this, { execution: "sync" });
			arg(this, { execution: "async" });
			return;
		}
		const lines = arg.split("\n").filter((x) => x);
		const minIndent = Math.min(...lines.map((x) => x.length - x.trimStart().length));
		const dedented = lines.map((x) => x.slice(minIndent)).map((x) => " ".repeat(this.indent * 2) + x);
		for (const line of dedented) this.content.push(line);
	}
	compile() {
		const F = Function;
		const content = this?.content ?? [``];
		return new F(...Object.keys(this.closed), `return function (${this.args.join(", ")}) {\n${content.join("\n")}\n};`)(...Object.values(this.closed));
	}
};
//#endregion
//#region node_modules/zod/v4/core/versions.js
const version = {
	major: 4,
	minor: 6,
	patch: 7
};
//#endregion
//#region node_modules/zod/v4/core/schemas.js
const $ZodType = /* @__PURE__ */ $constructor("$ZodType", (inst, def) => {
	var _a;
	inst ?? (inst = {});
	inst._zod.def = def;
	inst._zod.bag = inst._zod.bag || {};
	inst._zod.version = version;
	const defChecks = inst._zod.def.checks;
	const checks = inst._zod.traits.has("$ZodCheck") ? [inst, ...defChecks ?? []] : defChecks?.length ? [...defChecks] : [];
	for (const ch of checks) for (const fn of ch._zod.onattach) fn(inst);
	if (checks.length === 0) {
		(_a = inst._zod).deferred ?? (_a.deferred = []);
		inst._zod.deferred?.push(() => {
			inst._zod.run = inst._zod.parse;
		});
	} else {
		const runChecks = (payload, checks, ctx) => {
			if (payload.memo) return payload;
			let isAborted = aborted(payload);
			let asyncResult;
			for (const ch of checks) {
				if (ch._zod.def.when) {
					if (explicitlyAborted(payload)) continue;
					if (!ch._zod.def.when(payload)) continue;
				} else if (isAborted) continue;
				const currLen = payload.issues.length;
				const _ = ch._zod.check(payload);
				if (_ instanceof Promise && ctx?.async === false) throw new $ZodAsyncError();
				if (asyncResult || _ instanceof Promise) asyncResult = (asyncResult ?? Promise.resolve()).then(async () => {
					await _;
					if (payload.issues.length === currLen) return;
					attachSchema(payload.issues, currLen, inst);
					if (!isAborted) isAborted = aborted(payload, currLen);
				});
				else {
					if (payload.issues.length === currLen) continue;
					attachSchema(payload.issues, currLen, inst);
					if (!isAborted) isAborted = aborted(payload, currLen);
				}
			}
			if (asyncResult) return asyncResult.then(() => {
				return payload;
			});
			return payload;
		};
		const handleCanaryResult = (canary, payload, ctx) => {
			if (aborted(canary)) {
				canary.aborted = true;
				return canary;
			}
			const checkResult = runChecks(payload, checks, ctx);
			if (checkResult instanceof Promise) {
				if (ctx.async === false) throw new $ZodAsyncError();
				return checkResult.then((checkResult) => inst._zod.parse(checkResult, ctx));
			}
			return inst._zod.parse(checkResult, ctx);
		};
		inst._zod.run = (payload, ctx) => {
			if (ctx.skipChecks) return inst._zod.parse(payload, ctx);
			if (ctx.direction === "backward") {
				const canary = inst._zod.parse({
					value: payload.value,
					issues: []
				}, {
					...ctx,
					skipChecks: true
				});
				if (canary instanceof Promise) return canary.then((canary) => {
					return handleCanaryResult(canary, payload, ctx);
				});
				return handleCanaryResult(canary, payload, ctx);
			}
			const result = inst._zod.parse(payload, ctx);
			if (result instanceof Promise) {
				if (ctx.async === false) throw new $ZodAsyncError();
				return result.then((result) => runChecks(result, checks, ctx));
			}
			return runChecks(result, checks, ctx);
		};
	}
}, {
	get "~standard"() {
		return hide(this, "~standard", standardProps(this));
	},
	set "~standard"(value) {
		own(this, "~standard", value);
	}
});
/** The Standard Schema surface for `inst`. Shared so wrappers can extend it without forcing it. */
const toStandardResult = (r, ctx) => r.issues.length ? { issues: r.issues.map((iss) => finalizeIssue(iss, ctx, config())) } : { value: r.value };
async function validateAsync(inst, value) {
	const ctx = { async: true };
	return toStandardResult(await inst._zod.run({
		value,
		issues: []
	}, ctx), ctx);
}
function standardProps(inst) {
	return {
		validate: (value) => {
			const ctx = { async: false };
			try {
				const r = inst._zod.run({
					value,
					issues: []
				}, ctx);
				if (!(r instanceof Promise)) return toStandardResult(r, ctx);
			} catch (_) {}
			return validateAsync(inst, value);
		},
		vendor: "zod",
		version: 1
	};
}
const $ZodString = /* @__PURE__ */ $constructor("$ZodString", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.pattern = def.pattern ?? anyString;
	inst._zod.parse = (payload, _) => {
		if (def.coerce) try {
			payload.value = String(payload.value);
		} catch (_) {}
		if (typeof payload.value === "string") return payload;
		payload.issues.push({
			expected: "string",
			code: "invalid_type",
			input: payload.value,
			inst
		});
		return payload;
	};
});
const $ZodStringFormat = /* @__PURE__ */ $constructor("$ZodStringFormat", (inst, def) => {
	$ZodCheckStringFormat.init(inst, def);
	$ZodString.init(inst, def);
});
const $ZodGUID = /* @__PURE__ */ $constructor("$ZodGUID", (inst, def) => {
	def.pattern ?? (def.pattern = guid);
	$ZodStringFormat.init(inst, def);
});
const $ZodUUID = /* @__PURE__ */ $constructor("$ZodUUID", (inst, def) => {
	if (def.version) {
		const v = {
			v1: 1,
			v2: 2,
			v3: 3,
			v4: 4,
			v5: 5,
			v6: 6,
			v7: 7,
			v8: 8
		}[def.version];
		if (v === void 0) throw new Error(`Invalid UUID version: "${def.version}"`);
		def.pattern ?? (def.pattern = uuid(v));
	} else def.pattern ?? (def.pattern = uuid());
	$ZodStringFormat.init(inst, def);
});
const $ZodEmail = /* @__PURE__ */ $constructor("$ZodEmail", (inst, def) => {
	def.pattern ?? (def.pattern = email);
	$ZodStringFormat.init(inst, def);
});
function canParseURL(input) {
	try {
		if (typeof URL !== "undefined" && typeof URL.canParse === "function") return URL.canParse(input);
		new URL(input);
		return true;
	} catch {
		return false;
	}
}
function validateURL(trimmed, def) {
	if (!("normalize" in def) && !("hostname" in def) && !("protocol" in def)) return canParseURL(trimmed) || 2;
	return parseURLObject(trimmed, def);
}
/** Parses a URL while preserving the non-normalizing HTTP guard. */
function parseURLObject(trimmed, def) {
	if (!def.normalize && def.protocol?.source === httpProtocol.source && !/^https?:\/\//i.test(trimmed)) return 1;
	try {
		if (typeof URL !== "undefined") {
			const URLStatic = URL;
			if (typeof URLStatic.parse === "function") return URLStatic.parse(trimmed) ?? 2;
		}
		return new URL(trimmed);
	} catch {
		return 2;
	}
}
const asciiTabOrNewline = /[\t\n\r]/g;
/** The URL parser deletes every ASCII tab, LF and CR from its input before it parses, so `new URL("https://exa\nmple.com")` reports on `example.com`. Applying the same deletion to the returned value closes the half of that divergence which can move the host; the parser's other rewrite, stripping C0 controls at the edges, cannot. */
function stripTabAndNewline(value) {
	return value.replace(asciiTabOrNewline, "");
}
function urlHostnameOk(url, hostname) {
	hostname.lastIndex = 0;
	return hostname.test(url.hostname);
}
function urlProtocolOk(url, protocol) {
	protocol.lastIndex = 0;
	return protocol.test(url.protocol.endsWith(":") ? url.protocol.slice(0, -1) : url.protocol);
}
const $ZodURL = /* @__PURE__ */ $constructor("$ZodURL", (inst, def) => {
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		try {
			const trimmed = payload.value.trim();
			const url = validateURL(trimmed, def);
			if (url === 1) {
				payload.issues.push({
					code: "invalid_format",
					format: "url",
					note: "Invalid URL format",
					input: payload.value,
					inst,
					continue: !def.abort
				});
				return;
			}
			if (url === 2) {
				payload.issues.push({
					code: "invalid_format",
					format: "url",
					input: payload.value,
					inst,
					continue: !def.abort
				});
				return;
			}
			if (url === true) {
				payload.value = stripTabAndNewline(trimmed);
				return;
			}
			if (def.hostname && !urlHostnameOk(url, def.hostname)) payload.issues.push({
				code: "invalid_format",
				format: "url",
				note: "Invalid hostname",
				pattern: def.hostname.source,
				input: payload.value,
				inst,
				continue: !def.abort
			});
			if (def.protocol && !urlProtocolOk(url, def.protocol)) payload.issues.push({
				code: "invalid_format",
				format: "url",
				note: "Invalid protocol",
				pattern: def.protocol.source,
				input: payload.value,
				inst,
				continue: !def.abort
			});
			payload.value = def.normalize ? url.href : stripTabAndNewline(trimmed);
			return;
		} catch (_) {
			payload.issues.push({
				code: "invalid_format",
				format: "url",
				input: payload.value,
				inst,
				continue: !def.abort
			});
		}
	};
});
const $ZodEmoji = /* @__PURE__ */ $constructor("$ZodEmoji", (inst, def) => {
	def.pattern ?? (def.pattern = emoji());
	$ZodStringFormat.init(inst, def);
});
const $ZodNanoID = /* @__PURE__ */ $constructor("$ZodNanoID", (inst, def) => {
	if (def.length !== void 0 && (!Number.isInteger(def.length) || def.length < 1)) throw new Error(`Invalid nanoid length: ${def.length}`);
	def.pattern ?? (def.pattern = def.length === void 0 ? nanoid : nanoidOfLength(def.length));
	$ZodStringFormat.init(inst, def);
});
/**
* @deprecated CUID v1 is deprecated by its authors due to information leakage
* (timestamps embedded in the id). Use {@link $ZodCUID2} instead.
* See https://github.com/paralleldrive/cuid.
*/
const $ZodCUID = /* @__PURE__ */ $constructor("$ZodCUID", (inst, def) => {
	def.pattern ?? (def.pattern = cuid);
	$ZodStringFormat.init(inst, def);
});
const $ZodCUID2 = /* @__PURE__ */ $constructor("$ZodCUID2", (inst, def) => {
	def.pattern ?? (def.pattern = cuid2);
	$ZodStringFormat.init(inst, def);
});
const $ZodULID = /* @__PURE__ */ $constructor("$ZodULID", (inst, def) => {
	def.pattern ?? (def.pattern = ulid);
	$ZodStringFormat.init(inst, def);
});
const $ZodXID = /* @__PURE__ */ $constructor("$ZodXID", (inst, def) => {
	def.pattern ?? (def.pattern = xid);
	$ZodStringFormat.init(inst, def);
});
const $ZodKSUID = /* @__PURE__ */ $constructor("$ZodKSUID", (inst, def) => {
	def.pattern ?? (def.pattern = ksuid);
	$ZodStringFormat.init(inst, def);
});
const $ZodISODateTime = /* @__PURE__ */ $constructor("$ZodISODateTime", (inst, def) => {
	def.pattern ?? (def.pattern = datetime(def));
	$ZodStringFormat.init(inst, def);
});
const $ZodISODate = /* @__PURE__ */ $constructor("$ZodISODate", (inst, def) => {
	def.pattern ?? (def.pattern = date);
	$ZodStringFormat.init(inst, def);
});
const $ZodISOTime = /* @__PURE__ */ $constructor("$ZodISOTime", (inst, def) => {
	def.pattern ?? (def.pattern = time(def));
	$ZodStringFormat.init(inst, def);
});
const $ZodISODuration = /* @__PURE__ */ $constructor("$ZodISODuration", (inst, def) => {
	def.pattern ?? (def.pattern = duration);
	$ZodStringFormat.init(inst, def);
});
const $ZodIPv4 = /* @__PURE__ */ $constructor("$ZodIPv4", (inst, def) => {
	def.pattern ?? (def.pattern = ipv4);
	$ZodStringFormat.init(inst, def);
});
/** An IPv6 address is written with hex digits, colons and dots, and nothing else. The guard is what makes the check below an IPv6 check: `new URL("http://[...]")` parses an authority, not an address, so `@` and `\` re-delimit it and `"::@1\\"` validates against the host `0.0.0.1`. The URL parser also deletes ASCII tab, LF and CR rather than failing, which is how `"::1\n"` validated as `::1`. */
const ipv6Alphabet = /^[0-9a-fA-F:.]+$/;
function isValidIPv6(value) {
	if (!ipv6Alphabet.test(value)) return false;
	return canParseURL(`http://[${value}]`);
}
const $ZodIPv6 = /* @__PURE__ */ $constructor("$ZodIPv6", (inst, def) => {
	def.pattern ?? (def.pattern = ipv6);
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		if (!isValidIPv6(payload.value)) payload.issues.push({
			code: "invalid_format",
			format: "ipv6",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCIDRv4 = /* @__PURE__ */ $constructor("$ZodCIDRv4", (inst, def) => {
	def.pattern ?? (def.pattern = cidrv4);
	$ZodStringFormat.init(inst, def);
});
function isValidCIDRv6(value) {
	const parts = value.split("/");
	if (parts.length !== 2) return false;
	const [address, prefix] = parts;
	if (!prefix) return false;
	const prefixNum = Number(prefix);
	if (`${prefixNum}` !== prefix) return false;
	if (prefixNum < 0 || prefixNum > 128) return false;
	return isValidIPv6(address);
}
const $ZodCIDRv6 = /* @__PURE__ */ $constructor("$ZodCIDRv6", (inst, def) => {
	def.pattern ?? (def.pattern = cidrv6);
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		if (!isValidCIDRv6(payload.value)) payload.issues.push({
			code: "invalid_format",
			format: "cidrv6",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
function isValidBase64(data) {
	if (data === "") return true;
	if (/\s/.test(data)) return false;
	if (data.length % 4 !== 0) return false;
	try {
		atob(data);
		return true;
	} catch {
		return false;
	}
}
const base64Charset = /^[0-9a-zA-Z+/]*={0,2}$/;
const $ZodBase64 = /* @__PURE__ */ $constructor("$ZodBase64", (inst, def) => {
	def.pattern ?? (def.pattern = base64Charset);
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		if (isValidBase64(payload.value)) return;
		payload.issues.push({
			code: "invalid_format",
			format: "base64",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const base64urlCharset = /^[A-Za-z0-9_-]*$/;
function isValidBase64URL(data) {
	if (!base64urlCharset.test(data)) return false;
	const base64 = data.replace(/[-_]/g, (c) => c === "-" ? "+" : "/");
	return isValidBase64(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
}
const $ZodBase64URL = /* @__PURE__ */ $constructor("$ZodBase64URL", (inst, def) => {
	def.pattern ?? (def.pattern = base64urlCharset);
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		if (isValidBase64URL(payload.value)) return;
		payload.issues.push({
			code: "invalid_format",
			format: "base64url",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodE164 = /* @__PURE__ */ $constructor("$ZodE164", (inst, def) => {
	def.pattern ?? (def.pattern = e164);
	$ZodStringFormat.init(inst, def);
});
function isValidJWT(token, algorithm = null) {
	try {
		const tokensParts = token.split(".");
		if (tokensParts.length !== 3) return false;
		const [header] = tokensParts;
		if (!header) return false;
		const parsedHeader = JSON.parse(atob(header));
		if ("typ" in parsedHeader && parsedHeader?.typ !== "JWT") return false;
		if (!parsedHeader.alg) return false;
		if (algorithm && (!("alg" in parsedHeader) || parsedHeader.alg !== algorithm)) return false;
		return true;
	} catch {
		return false;
	}
}
const $ZodJWT = /* @__PURE__ */ $constructor("$ZodJWT", (inst, def) => {
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		if (isValidJWT(payload.value, def.alg)) return;
		payload.issues.push({
			code: "invalid_format",
			format: "jwt",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodNumber = /* @__PURE__ */ $constructor("$ZodNumber", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.pattern = number$1;
	inst._zod.parse = (payload, _ctx) => {
		if (def.coerce) try {
			payload.value = Number(payload.value);
		} catch (_) {}
		const input = payload.value;
		if (typeof input === "number" && !Number.isNaN(input) && Number.isFinite(input)) return payload;
		const received = typeof input === "number" ? Number.isNaN(input) ? "NaN" : !Number.isFinite(input) ? String(input) : void 0 : void 0;
		payload.issues.push({
			expected: "number",
			code: "invalid_type",
			input,
			inst,
			...received ? { received } : {}
		});
		return payload;
	};
});
const $ZodNumberFormat = /* @__PURE__ */ $constructor("$ZodNumberFormat", (inst, def) => {
	$ZodCheckNumberFormat.init(inst, def);
	$ZodNumber.init(inst, def);
});
const $ZodBoolean = /* @__PURE__ */ $constructor("$ZodBoolean", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.pattern = boolean$1;
	inst._zod.parse = (payload, _ctx) => {
		if (def.coerce) try {
			payload.value = Boolean(payload.value);
		} catch (_) {}
		const input = payload.value;
		if (typeof input === "boolean") return payload;
		payload.issues.push({
			expected: "boolean",
			code: "invalid_type",
			input,
			inst
		});
		return payload;
	};
});
const $ZodUnknown = /* @__PURE__ */ $constructor("$ZodUnknown", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload) => payload;
});
const $ZodNever = /* @__PURE__ */ $constructor("$ZodNever", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, _ctx) => {
		payload.issues.push({
			expected: "never",
			code: "invalid_type",
			input: payload.value,
			inst
		});
		return payload;
	};
});
function capSize(inst, size) {
	const caps = sizeCaps(inst._zod.def.checks);
	if (!caps.length) return;
	const cap = Math.min(...caps.map((c) => c[0]));
	const parse = inst._zod.parse;
	inst._zod.parse = (payload, ctx) => {
		const n = size(payload.value);
		if (n > cap && !ctx?.skipChecks && ctx?.direction !== "backward") {
			for (const [max, ch] of sizeCaps(inst._zod.def.checks)) if (n > max && ch._zod.def.when(payload)) {
				const start = payload.issues.length;
				ch._zod.check(payload);
				payload.issues[start].continue = false;
				attachSchema(payload.issues, start, inst);
				return payload;
			}
		}
		return parse(payload, ctx);
	};
}
const arraySize = (input) => Array.isArray(input) ? input.length : -1;
function handleArrayResult(result, final, index) {
	if (result.issues.length) final.issues.push(...prefixIssues(index, result.issues));
	final.value[index] = result.value;
}
const $ZodArray = /* @__PURE__ */ $constructor("$ZodArray", (inst, def) => {
	$ZodType.init(inst, def);
	const memo = globalConfig.memoizer;
	memo?.attach(inst);
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		if (!Array.isArray(input)) {
			payload.issues.push({
				expected: "array",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		payload.value = memo ? memo.alloc(inst, payload, Array(input.length), ctx) : Array(input.length);
		const proms = [];
		const abortEarly = ctx?.abortEarly;
		for (let i = 0; i < input.length; i++) {
			const item = input[i];
			const result = def.element._zod.run({
				value: item,
				issues: []
			}, ctx);
			if (result instanceof Promise) proms.push(result.then((result) => handleArrayResult(result, payload, i)));
			else {
				handleArrayResult(result, payload, i);
				if (abortEarly && result.issues.length !== 0 && aborted(result)) break;
			}
		}
		if (proms.length) return Promise.all(proms).then(() => payload);
		return payload;
	};
	capSize(inst, arraySize);
});
function handlePropertyResult(result, final, key, input, optin, optout) {
	const isPresent = key in input;
	const isOptionalOut = optout === "optional";
	if (!isPresent && isOptionalOut && optin === "optional") return;
	if (result.issues.length) {
		if (optin !== void 0 && isOptionalOut && !isPresent) return;
		final.issues.push(...prefixIssues(key, result.issues));
	}
	if (!isPresent && optin === void 0) {
		if (!result.issues.length) final.issues.push({
			code: "invalid_type",
			expected: "nonoptional",
			input: void 0,
			path: [key]
		});
		return;
	}
	if (result.value === void 0) {
		if (isPresent || optin === "defaulted" && !isOptionalOut) final.value[key] = void 0;
	} else final.value[key] = result.value;
}
const NO_SYMBOL_KEYS = [];
function normalizeDef(def) {
	const keys = Object.keys(def.shape);
	const ownSymbols = Object.getOwnPropertySymbols(def.shape);
	const symbolKeys = ownSymbols.length ? ownSymbols : NO_SYMBOL_KEYS;
	const allKeys = symbolKeys.length ? [...keys, ...symbolKeys] : keys;
	for (const k of allKeys) if (!def.shape?.[k]?._zod?.traits?.has("$ZodType")) throw new Error(`Invalid element at key "${String(k)}": expected a Zod schema`);
	const okeys = optionalKeys(def.shape);
	return {
		...def,
		allKeys,
		symbolKeys,
		keySet: new Set(keys),
		numKeys: keys.length,
		optionalKeys: new Set(okeys)
	};
}
function handleCatchall(proms, input, payload, ctx, def, inst, abortEarly) {
	const unrecognized = [];
	const keySet = def.keySet;
	const _catchall = def.catchall._zod;
	const t = _catchall.def.type;
	const optin = _catchall.optin;
	const optout = _catchall.optout;
	let seen = 0;
	for (const key in input) {
		if (abortEarly && payload.issues.length !== seen) {
			if (aborted(payload, seen)) break;
			seen = payload.issues.length;
		}
		if (keySet.has(key)) continue;
		if (key === "__proto__") {
			if (t === "never") unrecognized.push(key);
			continue;
		}
		if (t === "never") {
			unrecognized.push(key);
			continue;
		}
		const r = _catchall.run({
			value: input[key],
			issues: []
		}, ctx);
		if (r instanceof Promise) proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, optin, optout)));
		else handlePropertyResult(r, payload, key, input, optin, optout);
	}
	if (unrecognized.length) payload.issues.push({
		code: "unrecognized_keys",
		keys: unrecognized,
		input,
		inst,
		continue: true
	});
	if (!proms.length) return payload;
	return Promise.all(proms).then(() => {
		return payload;
	});
}
const $ZodObject = /* @__PURE__ */ $constructor("$ZodObject", (inst, def) => {
	$ZodType.init(inst, def);
	const desc = Object.getOwnPropertyDescriptor(def, "shape");
	const sh = desc?.get ? desc.get.raw : def.shape ?? {};
	if (sh) {
		const get = () => {
			const newSh = { ...sh };
			Object.defineProperty(def, "shape", { value: newSh });
			get.raw = newSh;
			return newSh;
		};
		get.raw = sh;
		Object.defineProperty(def, "shape", { get });
	}
	const _normalized = cached(() => normalizeDef(def));
	defineLazyInternal(inst, "propValues", (zod) => {
		const shape = zod.def.shape;
		const propValues = {};
		for (const key in shape) {
			const field = shape[key]._zod;
			if (field.values) {
				if (!Object.prototype.hasOwnProperty.call(propValues, key)) assignProp(propValues, key, /* @__PURE__ */ new Set());
				for (const v of field.values) propValues[key].add(v);
				if (field.optin !== void 0) propValues[key].add(void 0);
			}
		}
		return propValues;
	});
	const isObject$1 = isObject;
	const catchall = def.catchall;
	let value;
	const memo = globalConfig.memoizer;
	memo?.attach(inst);
	inst._zod.parse = (payload, ctx) => {
		value ?? (value = _normalized.value);
		const input = payload.value;
		if (!isObject$1(input)) {
			payload.issues.push({
				expected: "object",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		payload.value = memo ? memo.alloc(inst, payload, {}, ctx) : {};
		const proms = [];
		const shape = value.shape;
		const abortEarly = ctx?.abortEarly;
		let seen = payload.issues.length;
		for (const key of value.allKeys) {
			if (abortEarly && payload.issues.length !== seen) {
				if (aborted(payload, seen)) break;
				seen = payload.issues.length;
			}
			if (key === "__proto__") continue;
			const el = shape[key];
			const optin = el._zod.optin;
			const optout = el._zod.optout;
			const r = el._zod.run({
				value: input[key],
				issues: []
			}, ctx);
			if (r instanceof Promise) proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, optin, optout)));
			else handlePropertyResult(r, payload, key, input, optin, optout);
		}
		if (!catchall) return proms.length ? Promise.all(proms).then(() => payload) : payload;
		return handleCatchall(proms, input, payload, ctx, _normalized.value, inst, abortEarly === true);
	};
});
const $ZodObjectJIT = /* @__PURE__ */ $constructor("$ZodObjectJIT", (inst, def) => {
	$ZodObject.init(inst, def);
	const superParse = inst._zod.parse;
	const _normalized = cached(() => normalizeDef(def));
	const memo = globalConfig.memoizer;
	const generateFastpass = (shape) => {
		const normalized = _normalized.value;
		const syms = normalized.symbolKeys;
		const doc = new Doc(["payload", "ctx"], {
			shape,
			inst,
			memo,
			syms
		});
		const parseStr = (k) => `shape[${k}]._zod.run({ value: input[${k}], issues: [] }, ctx)`;
		const prefixStr = (id, k) => `
          let ${id}_ab = false;
          for (let i = 0; i < ${id}.issues.length; i++) {
            const iss = ${id}.issues[i];
            iss.path = iss.path ? [${k}, ...iss.path] : [${k}];
            payload.issues.push(iss);
            if (iss.continue !== true) ${id}_ab = true;
          }
          if (${id}_ab && ctx && ctx.abortEarly) {
            payload.value = newResult;
            return payload;
          }`;
		doc.write(`const input = payload.value;`);
		const ids = Object.create(null);
		let counter = 0;
		for (const key of normalized.allKeys) ids[key] = `key_${counter++}`;
		doc.write(memo ? `const newResult = memo.alloc(inst, payload, {}, ctx);` : `const newResult = {};`);
		for (const key of normalized.allKeys) {
			if (key === "__proto__") continue;
			const id = ids[key];
			const k = typeof key === "symbol" ? `syms[${syms.indexOf(key)}]` : esc(key);
			const isPresent = `${k} in input`;
			const schema = shape[key];
			const optin = schema?._zod?.optin;
			const isOptionalIn = optin !== void 0;
			const isOptionalOut = schema?._zod?.optout === "optional";
			doc.write(`const ${id} = ${parseStr(k)};`);
			if (isOptionalIn && isOptionalOut) {
				const assign = optin === "optional" ? `${id}_present` : `${id}.value !== undefined || ${id}_present`;
				doc.write(`
        const ${id}_present = ${isPresent};
        if (!${id}.issues.length || ${id}_present) {
          if (${id}.issues.length) {${prefixStr(id, k)}
          }

          if (${assign}) {
            newResult[${k}] = ${id}.value;
          }
        }

      `);
			} else if (!isOptionalIn) doc.write(`
        const ${id}_present = ${isPresent};
        if (${id}.issues.length) {${prefixStr(id, k)}
        }
        if (!${id}_present && !${id}.issues.length) {
          payload.issues.push({
            code: "invalid_type",
            expected: "nonoptional",
            input: undefined,
            path: [${k}]
          });
          if (ctx && ctx.abortEarly) {
            payload.value = newResult;
            return payload;
          }
        }

        if (${id}_present) {
          newResult[${k}] = ${id}.value;
        }

      `);
			else {
				doc.write(`
        if (${id}.issues.length) {${prefixStr(id, k)}
        }
      `);
				if (optin === "defaulted") doc.write(`newResult[${k}] = ${id}.value;`);
				else doc.write(`
        if (${id}.value !== undefined || ${isPresent}) {
          newResult[${k}] = ${id}.value;
        }
      `);
			}
		}
		doc.write(`payload.value = newResult;`);
		doc.write(`return payload;`);
		return doc.compile();
	};
	let fastpass;
	const isObject$2 = isObject;
	const jit = !globalConfig.jitless;
	const fastEnabled = jit && allowsEval.value;
	const catchall = def.catchall;
	let value;
	inst._zod.parse = (payload, ctx) => {
		value ?? (value = _normalized.value);
		const input = payload.value;
		if (!isObject$2(input)) {
			payload.issues.push({
				expected: "object",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		if (jit && fastEnabled && ctx?.async === false && ctx.jitless !== true) {
			if (!fastpass) fastpass = generateFastpass(def.shape);
			payload = fastpass(payload, ctx);
			if (!catchall) return payload;
			return handleCatchall([], input, payload, ctx, value, inst, ctx?.abortEarly === true);
		}
		return superParse(payload, ctx);
	};
});
function handleUnionResults(results, final, inst, ctx) {
	for (const result of results) if (result.issues.length === 0) {
		final.value = result.value;
		return final;
	}
	const nonaborted = results.filter((r) => !aborted(r));
	if (nonaborted.length === 1) {
		final.value = nonaborted[0].value;
		return nonaborted[0];
	}
	final.issues.push({
		code: "invalid_union",
		input: final.value,
		inst,
		errors: results.map((result) => result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
	});
	return final;
}
const $ZodUnion = /* @__PURE__ */ $constructor("$ZodUnion", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazyInternal(inst, "optin", (zod) => zod.def.options.some((o) => o._zod.optin === "defaulted") ? "defaulted" : zod.def.options.some((o) => o._zod.optin !== void 0) ? "optional" : void 0);
	defineLazyInternal(inst, "optout", (zod) => zod.def.options.some((o) => o._zod.optout === "optional") ? "optional" : void 0);
	defineLazyInternal(inst, "values", (zod) => {
		if (zod.def.options.every((o) => o._zod.values)) return new Set(zod.def.options.flatMap((option) => Array.from(option._zod.values)));
	});
	defineLazyInternal(inst, "pattern", (zod) => {
		if (zod.def.options.every((o) => o._zod.pattern)) {
			const patterns = zod.def.options.map((o) => o._zod.pattern);
			return new RegExp(`^(${patterns.map((p) => cleanRegex(p.source)).join("|")})$`);
		}
	});
	const first = def.options.length === 1 ? def.options[0]._zod.run : null;
	inst._zod.parse = (payload, ctx) => {
		if (first) return first(payload, ctx);
		let async = false;
		const results = [];
		for (const option of def.options) {
			const result = option._zod.run({
				value: payload.value,
				issues: []
			}, ctx);
			if (result instanceof Promise) {
				results.push(result);
				async = true;
			} else {
				if (result.issues.length === 0) return result;
				results.push(result);
			}
		}
		if (!async) return handleUnionResults(results, payload, inst, ctx);
		return Promise.all(results).then((results) => {
			return handleUnionResults(results, payload, inst, ctx);
		});
	};
});
const $ZodIntersection = /* @__PURE__ */ $constructor("$ZodIntersection", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		const left = def.left._zod.run({
			value: input,
			issues: []
		}, ctx);
		const right = def.right._zod.run({
			value: input,
			issues: []
		}, ctx);
		if (left instanceof Promise || right instanceof Promise) return Promise.all([left, right]).then(([left, right]) => {
			return handleIntersectionResults(payload, left, right);
		});
		return handleIntersectionResults(payload, left, right);
	};
});
function mergeValues(a, b) {
	if (a === b) return {
		valid: true,
		data: a
	};
	if (a instanceof Date && b instanceof Date && +a === +b) return {
		valid: true,
		data: a
	};
	if (isPlainObject(a) && isPlainObject(b)) {
		const bKeys = Object.keys(b);
		const sharedKeys = Object.keys(a).filter((key) => bKeys.indexOf(key) !== -1);
		const newObj = {
			...a,
			...b
		};
		if (Object.prototype.hasOwnProperty.call(newObj, "__proto__")) delete newObj.__proto__;
		for (const key of sharedKeys) {
			if (key === "__proto__") continue;
			const sharedValue = mergeValues(a[key], b[key]);
			if (!sharedValue.valid) return {
				valid: false,
				mergeErrorPath: [key, ...sharedValue.mergeErrorPath]
			};
			newObj[key] = sharedValue.data;
		}
		return {
			valid: true,
			data: newObj
		};
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return {
			valid: false,
			mergeErrorPath: []
		};
		const newArray = [];
		for (let index = 0; index < a.length; index++) {
			const itemA = a[index];
			const itemB = b[index];
			const sharedValue = mergeValues(itemA, itemB);
			if (!sharedValue.valid) return {
				valid: false,
				mergeErrorPath: [index, ...sharedValue.mergeErrorPath]
			};
			newArray.push(sharedValue.data);
		}
		return {
			valid: true,
			data: newArray
		};
	}
	return {
		valid: false,
		mergeErrorPath: []
	};
}
function handleIntersectionResults(result, left, right) {
	const unrecKeys = /* @__PURE__ */ new Map();
	let unrecIssue;
	const keyIssues = /* @__PURE__ */ new Map();
	const collect = (iss, side) => {
		let keys;
		if (iss.code === "unrecognized_keys" && !iss.path?.length) {
			unrecIssue ?? (unrecIssue = iss);
			keys = iss.keys;
		} else if (iss.code === "invalid_key" && iss.origin === "record" && iss.path?.length === 1) {
			const k = String(iss.path[0]);
			if (!keyIssues.has(k)) keyIssues.set(k, iss);
			keys = [k];
		} else return false;
		for (const k of keys) {
			if (!unrecKeys.has(k)) unrecKeys.set(k, {});
			unrecKeys.get(k)[side] = true;
		}
		return true;
	};
	for (const iss of left.issues) if (!collect(iss, "l")) result.issues.push(iss);
	for (const iss of right.issues) if (!collect(iss, "r")) result.issues.push(iss);
	const bothKeys = [...unrecKeys].filter(([, f]) => f.l && f.r).map(([k]) => k);
	if (bothKeys.length) {
		const aggregated = unrecIssue ? bothKeys.filter((k) => unrecIssue.keys.includes(k)) : [];
		if (aggregated.length) result.issues.push({
			...unrecIssue,
			keys: aggregated
		});
		for (const k of bothKeys) if (!aggregated.includes(k) && keyIssues.has(k)) result.issues.push(keyIssues.get(k));
	}
	const merged = mergeValues(left.value, right.value);
	if (!merged.valid) {
		if (aborted(result)) return result;
		throw new Error(`Unmergable intersection. Error path: ${JSON.stringify(merged.mergeErrorPath)}`);
	}
	result.value = merged.data;
	return result;
}
const $ZodRecord = /* @__PURE__ */ $constructor("$ZodRecord", (inst, def) => {
	$ZodType.init(inst, def);
	const memo = globalConfig.memoizer;
	memo?.attach(inst);
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		if (!isPlainObject(input)) {
			payload.issues.push({
				expected: "record",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		const proms = [];
		const values = def.keyType._zod.values;
		if (values && !def.partial) {
			payload.value = memo ? memo.alloc(inst, payload, {}, ctx) : {};
			const recordKeys = /* @__PURE__ */ new Set();
			for (const key of values) if (typeof key === "string" || typeof key === "number" || typeof key === "symbol") {
				recordKeys.add(typeof key === "number" ? key.toString() : key);
				if (key === "__proto__") continue;
				const keyResult = def.keyType._zod.run({
					value: key,
					issues: []
				}, ctx);
				if (keyResult instanceof Promise) throw new Error("Async schemas not supported in object keys currently");
				if (keyResult.issues.length) {
					payload.issues.push({
						code: "invalid_key",
						origin: "record",
						issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
						input: key,
						path: [key],
						inst
					});
					continue;
				}
				const outKey = keyResult.value;
				if (outKey === "__proto__") continue;
				const result = def.valueType._zod.run({
					value: input[key],
					issues: []
				}, ctx);
				if (result instanceof Promise) proms.push(result.then((result) => {
					if (result.issues.length) payload.issues.push(...prefixIssues(key, result.issues));
					payload.value[outKey] = result.value;
				}));
				else {
					if (result.issues.length) payload.issues.push(...prefixIssues(key, result.issues));
					payload.value[outKey] = result.value;
				}
			}
			let unrecognized;
			for (const key in input) if (!recordKeys.has(key)) if (def.mode === "loose") {
				if (key === "__proto__") continue;
				payload.value[key] = input[key];
			} else {
				unrecognized = unrecognized ?? [];
				unrecognized.push(key);
			}
			if (unrecognized && unrecognized.length > 0) payload.issues.push({
				code: "unrecognized_keys",
				input,
				inst,
				keys: unrecognized,
				continue: true
			});
		} else {
			payload.value = memo ? memo.alloc(inst, payload, {}, ctx) : {};
			let unrecognized;
			for (const key of Reflect.ownKeys(input)) {
				if (key === "__proto__") continue;
				if (!Object.prototype.propertyIsEnumerable.call(input, key)) continue;
				let keyResult = def.keyType._zod.run({
					value: key,
					issues: []
				}, ctx);
				if (keyResult instanceof Promise) throw new Error("Async schemas not supported in object keys currently");
				if (typeof key === "string" && number$1.test(key) && keyResult.issues.length) {
					const retryResult = def.keyType._zod.run({
						value: Number(key),
						issues: []
					}, ctx);
					if (retryResult instanceof Promise) throw new Error("Async schemas not supported in object keys currently");
					if (retryResult.issues.length === 0) keyResult = retryResult;
				}
				if (keyResult.issues.length) {
					if (def.mode === "loose") payload.value[key] = input[key];
					else if (values) {
						unrecognized = unrecognized ?? [];
						unrecognized.push(key);
					} else payload.issues.push({
						code: "invalid_key",
						origin: "record",
						issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
						input: key,
						path: [key],
						inst
					});
					continue;
				}
				const outKey = keyResult.value;
				if (outKey === "__proto__") continue;
				const result = def.valueType._zod.run({
					value: input[key],
					issues: []
				}, ctx);
				if (result instanceof Promise) proms.push(result.then((result) => {
					if (result.issues.length) payload.issues.push(...prefixIssues(key, result.issues));
					payload.value[outKey] = result.value;
				}));
				else {
					if (result.issues.length) payload.issues.push(...prefixIssues(key, result.issues));
					payload.value[outKey] = result.value;
				}
			}
			if (unrecognized && unrecognized.length > 0) payload.issues.push({
				code: "unrecognized_keys",
				input,
				inst,
				keys: unrecognized,
				continue: true
			});
		}
		if (proms.length) return Promise.all(proms).then(() => payload);
		return payload;
	};
});
const $ZodEnum = /* @__PURE__ */ $constructor("$ZodEnum", (inst, def) => {
	$ZodType.init(inst, def);
	const values = getEnumValues(def.entries);
	const valuesSet = new Set(values);
	inst._zod.values = valuesSet;
	defineLazyInternal(inst, "pattern", (zod) => {
		const patternValues = getEnumValues(zod.def.entries).filter((k) => propertyKeyTypes.has(typeof k));
		return new RegExp(patternValues.length ? `^(${patternValues.map((o) => escapeRegex(o.toString())).join("|")})$` : "^[^\\s\\S]$");
	});
	inst._zod.parse = (payload, _ctx) => {
		const input = payload.value;
		if (valuesSet.has(input)) return payload;
		payload.issues.push({
			code: "invalid_value",
			values,
			input,
			inst
		});
		return payload;
	};
});
const $ZodLiteral = /* @__PURE__ */ $constructor("$ZodLiteral", (inst, def) => {
	$ZodType.init(inst, def);
	const values = new Set(def.values);
	inst._zod.values = values;
	defineLazyInternal(inst, "pattern", (zod) => {
		const vals = zod.def.values;
		return new RegExp(vals.length ? `^(${vals.map((o) => typeof o === "string" ? escapeRegex(o) : o ? escapeRegex(o.toString()) : String(o)).join("|")})$` : "^[^\\s\\S]$");
	});
	inst._zod.parse = (payload, _ctx) => {
		const input = payload.value;
		if (values.has(input)) return payload;
		payload.issues.push({
			code: "invalid_value",
			values: def.values,
			input,
			inst
		});
		return payload;
	};
});
const $ZodTransform = /* @__PURE__ */ $constructor("$ZodTransform", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "optional";
	globalConfig.memoizer?.guard(inst);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") throw new $ZodEncodeError(inst.constructor.name);
		const _out = def.transform(payload.value, payload);
		if (ctx.async) return (_out instanceof Promise ? _out : Promise.resolve(_out)).then((output) => {
			payload.value = output;
			return payload;
		});
		if (_out instanceof Promise) throw new $ZodAsyncError();
		payload.value = _out;
		return payload;
	};
});
function handleOptionalResult(payload, result) {
	payload.value = result.issues.length ? void 0 : result.value;
	return payload;
}
const $ZodOptional = /* @__PURE__ */ $constructor("$ZodOptional", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazyInternal(inst, "optin", (zod) => zod.def.innerType._zod.optin === "defaulted" ? "defaulted" : "optional");
	inst._zod.optout = "optional";
	defineLazyInternal(inst, "values", (zod) => {
		const values = zod.def.innerType._zod.values;
		return values ? new Set([...values, void 0]) : void 0;
	});
	defineLazyInternal(inst, "pattern", (zod) => {
		const pattern = zod.def.innerType._zod.pattern;
		return pattern ? new RegExp(`^(${cleanRegex(pattern.source)})?$`) : void 0;
	});
	inst._zod.parse = (payload, ctx) => {
		if (payload.value === void 0) {
			if (def.innerType._zod.optin !== "defaulted") return payload;
			const result = def.innerType._zod.run({
				value: payload.value,
				issues: []
			}, ctx);
			if (result instanceof Promise) return result.then((result) => handleOptionalResult(payload, result));
			return handleOptionalResult(payload, result);
		}
		return def.innerType._zod.run(payload, ctx);
	};
});
const $ZodExactOptional = /* @__PURE__ */ $constructor("$ZodExactOptional", (inst, def) => {
	$ZodOptional.init(inst, def);
	defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
	defineLazyInternal(inst, "pattern", (zod) => zod.def.innerType._zod.pattern);
	inst._zod.parse = (payload, ctx) => {
		return def.innerType._zod.run(payload, ctx);
	};
});
const $ZodNullable = /* @__PURE__ */ $constructor("$ZodNullable", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazyInternal(inst, "optin", (zod) => zod.def.innerType._zod.optin);
	defineLazyInternal(inst, "optout", (zod) => zod.def.innerType._zod.optout);
	defineLazyInternal(inst, "pattern", (zod) => {
		const pattern = zod.def.innerType._zod.pattern;
		return pattern ? new RegExp(`^(${cleanRegex(pattern.source)}|null)$`) : void 0;
	});
	defineLazyInternal(inst, "values", (zod) => {
		return zod.def.innerType._zod.values ? new Set([...zod.def.innerType._zod.values, null]) : void 0;
	});
	inst._zod.parse = (payload, ctx) => {
		if (payload.value === null) return payload;
		return def.innerType._zod.run(payload, ctx);
	};
});
const $ZodDefault = /* @__PURE__ */ $constructor("$ZodDefault", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "defaulted";
	defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		if (payload.value === void 0) {
			payload.value = def.defaultValue;
			/**
			* $ZodDefault returns the default value immediately in forward direction.
			* It doesn't pass the default value into the validator ("prefault"). There's no reason to pass the default value through validation. The validity of the default is enforced by TypeScript statically. Otherwise, it's the responsibility of the user to ensure the default is valid. In the case of pipes with divergent in/out types, you can specify the default on the `in` schema of your ZodPipe to set a "prefault" for the pipe.   */
			return payload;
		}
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then((result) => handleDefaultResult(result, def));
		return handleDefaultResult(result, def);
	};
});
function handleDefaultResult(payload, def) {
	if (payload.value === void 0) payload.value = def.defaultValue;
	return payload;
}
const $ZodPrefault = /* @__PURE__ */ $constructor("$ZodPrefault", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "defaulted";
	defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		if (payload.value === void 0) payload.value = def.defaultValue;
		return def.innerType._zod.run(payload, ctx);
	};
});
const $ZodNonOptional = /* @__PURE__ */ $constructor("$ZodNonOptional", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazyInternal(inst, "values", (zod) => {
		const v = zod.def.innerType._zod.values;
		return v ? new Set([...v].filter((x) => x !== void 0)) : void 0;
	});
	inst._zod.parse = (payload, ctx) => {
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then((result) => handleNonOptionalResult(result, inst));
		return handleNonOptionalResult(result, inst);
	};
});
function handleNonOptionalResult(payload, inst) {
	if (!payload.issues.length && payload.value === void 0) payload.issues.push({
		code: "invalid_type",
		expected: "nonoptional",
		input: payload.value,
		inst
	});
	return payload;
}
function handleCatchResult(payload, result, def, ctx) {
	if (!result.issues.length) {
		payload.value = result.value;
		if (result.memo) payload.memo = true;
		return payload;
	}
	payload.value = def.catchValue({
		...result,
		value: payload.value,
		error: { issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config())) },
		input: payload.value
	});
	return payload;
}
const $ZodCatch = /* @__PURE__ */ $constructor("$ZodCatch", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazyInternal(inst, "optin", (zod) => zod.def.innerType._zod.optin === "defaulted" ? "defaulted" : "optional");
	defineLazyInternal(inst, "optout", (zod) => zod.def.innerType._zod.optout);
	defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		const result = def.innerType._zod.run({
			value: payload.value,
			issues: []
		}, ctx);
		if (result instanceof Promise) return result.then((result) => handleCatchResult(payload, result, def, ctx));
		return handleCatchResult(payload, result, def, ctx);
	};
});
const $ZodPipe = /* @__PURE__ */ $constructor("$ZodPipe", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazyInternal(inst, "values", (zod) => zod.def.in._zod.values);
	defineLazyInternal(inst, "optin", (zod) => zod.def.in._zod.optin);
	defineLazyInternal(inst, "optout", (zod) => zod.def.out._zod.optout);
	defineLazyInternal(inst, "propValues", (zod) => zod.def.in._zod.propValues);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") {
			const right = def.out._zod.run(payload, ctx);
			if (right instanceof Promise) return right.then((right) => handlePipeResult(right, def.in, ctx));
			return handlePipeResult(right, def.in, ctx);
		}
		const left = def.in._zod.run(payload, ctx);
		if (left instanceof Promise) return left.then((left) => handlePipeResult(left, def.out, ctx));
		return handlePipeResult(left, def.out, ctx);
	};
});
function handlePipeResult(left, next, ctx) {
	if (left.issues.some((iss) => iss.code !== "unrecognized_keys")) {
		left.aborted = true;
		return left;
	}
	return next._zod.run({
		value: left.value,
		issues: left.issues
	}, ctx);
}
const $ZodReadonly = /* @__PURE__ */ $constructor("$ZodReadonly", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazyInternal(inst, "propValues", (zod) => zod.def.innerType._zod.propValues);
	defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
	defineLazyInternal(inst, "optin", (zod) => zod.def.innerType?._zod?.optin);
	defineLazyInternal(inst, "optout", (zod) => zod.def.innerType?._zod?.optout);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then(handleReadonlyResult);
		return handleReadonlyResult(result);
	};
});
function handleReadonlyResult(payload) {
	if (!payload.memo) payload.value = Object.freeze(payload.value);
	return payload;
}
const $ZodCustom = /* @__PURE__ */ $constructor("$ZodCustom", (inst, def) => {
	$ZodCheck.init(inst, def);
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, _) => {
		return payload;
	};
	inst._zod.check = (payload) => {
		const input = payload.value;
		const r = def.fn(input);
		if (r instanceof Promise) return r.then((r) => handleRefineResult(r, payload, input, inst));
		handleRefineResult(r, payload, input, inst);
	};
});
function handleRefineResult(result, payload, input, inst) {
	if (!result) {
		const _iss = {
			code: "custom",
			input,
			inst,
			path: [...inst._zod.def.path ?? []],
			continue: !inst._zod.def.abort
		};
		if (inst._zod.def.params) _iss.params = inst._zod.def.params;
		payload.issues.push(issue(_iss));
	}
}
//#endregion
//#region node_modules/zod/v4/core/memoizer.js
var $ZodCyclicError = class extends Error {
	constructor() {
		super(`Cannot parse a reference cycle that closes through a transform`);
		this.name = "ZodCyclicError";
	}
};
/** Keyed off the context object every schema in one parse call already shares. */
const STATE = "~memo";
const NO_ISSUES = [];
function isRef(value) {
	return value !== null && typeof value === "object";
}
function cloneIssues(issues) {
	return issues.map((iss) => iss.path ? {
		...iss,
		path: iss.path.slice()
	} : { ...iss });
}
const recursive = /* @__PURE__ */ new WeakMap();
/** What the walk established, in order of certainty: ordered so the strongest answer among children wins. */
const NONE = 0;
const ASSUMED = 1;
const PROVEN = 2;
/** Whether this schema's subtree contains a cycle, so one parse can re-enter it. */
function isRecursive(inst, stack, resolve) {
	const cached = recursive.get(inst);
	if (cached !== void 0) return cached ? PROVEN : NONE;
	if (stack.has(inst)) return PROVEN;
	stack.add(inst);
	let result = NONE;
	const check = (child) => {
		if (result !== PROVEN && child?._zod) {
			const answer = isRecursive(child, stack, resolve);
			if (answer > result) result = answer;
		}
	};
	const shape = (sh, spread) => {
		let answer = NONE;
		for (const key of Reflect.ownKeys(sh)) {
			const desc = Object.getOwnPropertyDescriptor(sh, key);
			if (spread && !desc.enumerable) continue;
			const child = desc.get ? ASSUMED : desc.value?._zod ? isRecursive(desc.value, stack, resolve) : NONE;
			if (child > answer) answer = child;
		}
		return answer;
	};
	const merge = (answer) => {
		if (answer > result) result = answer;
	};
	const def = inst._zod.def;
	switch (def.type) {
		case "object": {
			const raw = rawShape(def);
			merge(raw ? shape(raw, true) : ASSUMED);
			check(def.catchall);
			break;
		}
		case "array":
			check(def.element);
			break;
		case "tuple":
			for (const el of def.items) check(el);
			check(def.rest);
			break;
		case "record":
		case "map":
			check(def.keyType);
			check(def.valueType);
			break;
		case "set":
			check(def.valueType);
			break;
		case "union":
			for (const el of def.options) check(el);
			break;
		case "intersection":
			check(def.left);
			check(def.right);
			break;
		case "optional":
		case "nullable":
		case "default":
		case "prefault":
		case "catch":
		case "readonly":
		case "nonoptional":
		case "promise":
		case "success":
			check(def.innerType);
			break;
		case "pipe":
			check(def.in);
			check(def.out);
			break;
		case "function":
			check(def.input);
			check(def.output);
			break;
		case "lazy": {
			const inner = def._cachedInner ?? (resolve ? inst._zod.innerType : void 0);
			merge(inner ? isRecursive(inner, stack, false) : ASSUMED);
			break;
		}
		case "template_literal":
		case "string":
		case "number":
		case "int":
		case "boolean":
		case "bigint":
		case "symbol":
		case "undefined":
		case "null":
		case "void":
		case "never":
		case "any":
		case "unknown":
		case "date":
		case "nan":
		case "enum":
		case "literal":
		case "file":
		case "transform":
		case "custom": break;
		default: for (const key in def) {
			const desc = Object.getOwnPropertyDescriptor(def, key);
			if (!desc || desc.get) continue;
			const value = desc.value;
			if (!value || typeof value !== "object") continue;
			if (value._zod) check(value);
			else if (Array.isArray(value)) for (const el of value) check(el);
		}
	}
	stack.delete(inst);
	return settle(inst, result);
}
/** An assumed answer must not outlive the resolution that settles it, so only a certain one is cached. */
function settle(inst, answer) {
	if (answer !== ASSUMED) recursive.set(inst, answer === PROVEN);
	return answer;
}
function bucketFor(state, inst) {
	let bucket = state.buckets.get(inst);
	if (!bucket) {
		bucket = /* @__PURE__ */ new WeakMap();
		state.buckets.set(inst, bucket);
	}
	return bucket;
}
let handoff;
const open = [];
const memo = {
	alloc(_inst, payload, empty) {
		const bucket = handoff;
		if (!bucket) return empty;
		handoff = void 0;
		const entry = {
			value: empty,
			issues: null
		};
		bucket.set(payload.value, entry);
		open.push(entry);
		return empty;
	},
	guard(inst) {
		var _a;
		(_a = inst._zod).deferred ?? (_a.deferred = []);
		inst._zod.deferred.push(() => {
			const base = inst._zod.parse;
			const wrapped = (payload, ctx) => {
				if (ctx.direction !== "backward" && isBackEdge(ctx, payload.value)) throw new $ZodCyclicError();
				return base(payload, ctx);
			};
			inst._zod.parse = wrapped;
			if (inst._zod.run === base) inst._zod.run = wrapped;
		});
	},
	attach(inst) {
		var _a;
		let isRecursiveInst;
		let rechecked = false;
		let lastCtx;
		let lastBucket;
		(_a = inst._zod).deferred ?? (_a.deferred = []);
		inst._zod.deferred.push(() => {
			const base = inst._zod.parse;
			const wrapped = (payload, ctx) => {
				if (isRecursiveInst === void 0) {
					const walked = isRecursive(inst, /* @__PURE__ */ new Set(), false);
					if (walked === NONE) {
						inst._zod.parse = base;
						if (inst._zod.run === wrapped) inst._zod.run = base;
						return base(payload, ctx);
					}
					if (walked === PROVEN || rechecked) isRecursiveInst = true;
					else rechecked = true;
				}
				const input = payload.value;
				if (!isRef(input)) return base(payload, ctx);
				let state = ctx[STATE];
				if (!state) {
					state = {
						buckets: /* @__PURE__ */ new WeakMap(),
						backEdges: void 0
					};
					ctx[STATE] = state;
				}
				let bucket;
				if (lastCtx === ctx) bucket = lastBucket;
				else {
					bucket = bucketFor(state, inst);
					lastCtx = ctx;
					lastBucket = bucket;
				}
				const hit = bucket.get(input);
				if (hit) {
					payload.value = hit.value;
					if (hit.issues) {
						if (hit.issues.length) payload.issues.push(...cloneIssues(hit.issues));
					} else {
						payload.memo = true;
						state.backEdges ?? (state.backEdges = /* @__PURE__ */ new WeakSet());
						state.backEdges.add(hit.value);
					}
					return payload;
				}
				handoff = bucket;
				const depth = open.length;
				const result = base(payload, ctx);
				handoff = void 0;
				const entry = open.length > depth ? open.pop() : void 0;
				if (result instanceof Promise) return result.then((r) => {
					if (entry) entry.issues = r.issues.length ? cloneIssues(r.issues) : NO_ISSUES;
					return r;
				});
				if (entry) entry.issues = result.issues.length ? cloneIssues(result.issues) : NO_ISSUES;
				return result;
			};
			inst._zod.parse = wrapped;
			if (inst._zod.run === base) inst._zod.run = wrapped;
		});
	}
};
/** The memoizer that gives containers cycle support. `zod` installs it by default; `zod/mini` opts in with `config({ memoizer: memoizer() })`. */
function memoizer() {
	return memo;
}
/** Whether this value is a node a back-edge resolved to before it finished. */
function isBackEdge(ctx, value) {
	const backEdges = ctx[STATE]?.backEdges;
	return backEdges !== void 0 && isRef(value) && backEdges.has(value);
}
//#endregion
//#region node_modules/zod/v4/locales/en.js
const error = () => {
	const Sizable = {
		string: {
			unit: "characters",
			verb: "to have"
		},
		file: {
			unit: "bytes",
			verb: "to have"
		},
		array: {
			unit: "items",
			verb: "to have"
		},
		set: {
			unit: "items",
			verb: "to have"
		},
		map: {
			unit: "entries",
			verb: "to have"
		}
	};
	function getSizing(origin) {
		return Sizable[origin] ?? null;
	}
	const FormatDictionary = {
		regex: "input",
		email: "email address",
		url: "URL",
		emoji: "emoji",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "ISO datetime",
		date: "ISO date",
		time: "ISO time",
		duration: "ISO duration",
		ipv4: "IPv4 address",
		ipv6: "IPv6 address",
		mac: "MAC address",
		cidrv4: "IPv4 range",
		cidrv6: "IPv6 range",
		base64: "base64-encoded string",
		base64url: "base64url-encoded string",
		json_string: "JSON string",
		e164: "E.164 number",
		currency_code: "currency code",
		credit_card: "credit card number",
		iban: "IBAN",
		jwt: "JWT",
		template_literal: "input"
	};
	const TypeDictionary = { nan: "NaN" };
	function getTypeName(type, input) {
		if (type === "number" && typeof input === "number" && !Number.isFinite(input)) return String(input);
		return TypeDictionary[type] ?? type;
	}
	return (issue) => {
		switch (issue.code) {
			case "invalid_type": return `Invalid input: expected ${getTypeName(issue.expected)}, received ${getTypeName(parsedType(issue.input), issue.input)}`;
			case "invalid_value":
				if (issue.values.length === 1) return `Invalid input: expected ${stringifyPrimitive(issue.values[0])}`;
				return `Invalid option: expected one of ${joinValues(issue.values, "|")}`;
			case "too_big": {
				const adj = issue.exact ? "exactly " : issue.inclusive ? "<=" : "<";
				const sizing = getSizing(issue.origin);
				if (sizing) return `Too big: expected ${issue.origin ?? "value"} to have ${adj}${issue.maximum.toString()} ${sizing.unit ?? "elements"}`;
				return `Too big: expected ${issue.origin ?? "value"} to be ${adj}${issue.maximum.toString()}`;
			}
			case "too_small": {
				const adj = issue.exact ? "exactly " : issue.inclusive ? ">=" : ">";
				const sizing = getSizing(issue.origin);
				if (sizing) return `Too small: expected ${issue.origin} to have ${adj}${issue.minimum.toString()} ${sizing.unit}`;
				return `Too small: expected ${issue.origin} to be ${adj}${issue.minimum.toString()}`;
			}
			case "invalid_format": {
				const _issue = issue;
				if (_issue.format === "starts_with") return `Invalid string: must start with "${_issue.prefix}"`;
				if (_issue.format === "ends_with") return `Invalid string: must end with "${_issue.suffix}"`;
				if (_issue.format === "includes") return `Invalid string: must include "${_issue.includes}"`;
				if (_issue.format === "regex") return `Invalid string: must match pattern ${_issue.pattern}`;
				return `Invalid ${FormatDictionary[_issue.format] ?? issue.format}`;
			}
			case "not_multiple_of": return `Invalid number: must be a multiple of ${issue.divisor}`;
			case "unrecognized_keys": return `Unrecognized key${issue.keys.length > 1 ? "s" : ""}: ${joinValues(issue.keys, ", ")}`;
			case "invalid_key": return `Invalid key in ${issue.origin}`;
			case "invalid_union":
				if (issue.options && Array.isArray(issue.options) && issue.options.length > 0) return `Invalid discriminator value. Expected ${issue.options.map((o) => `'${o}'`).join(" | ")}`;
				if (issue.inclusive === false) return "Invalid input: more than one option matched";
				return "Invalid input";
			case "invalid_element": return `Invalid value in ${issue.origin}`;
			default: return `Invalid input`;
		}
	};
};
function en_default() {
	return { localeError: error() };
}
//#endregion
//#region node_modules/zod/v4/core/registries.js
var _a;
var $ZodRegistry = class {
	constructor() {
		this._map = /* @__PURE__ */ new WeakMap();
		this._idmap = /* @__PURE__ */ new Map();
	}
	add(schema, ..._meta) {
		const meta = _meta[0];
		this._map.set(schema, meta);
		if (meta && typeof meta === "object" && "id" in meta) this._idmap.set(meta.id, schema);
		return this;
	}
	clear() {
		this._map = /* @__PURE__ */ new WeakMap();
		this._idmap = /* @__PURE__ */ new Map();
		return this;
	}
	remove(schema) {
		const meta = this._map.get(schema);
		if (meta && typeof meta === "object" && "id" in meta) this._idmap.delete(meta.id);
		this._map.delete(schema);
		return this;
	}
	get(schema) {
		const p = schema._zod.parent;
		if (p) {
			const pm = { ...this.get(p) ?? {} };
			delete pm.id;
			const f = {
				...pm,
				...this._map.get(schema)
			};
			return Object.keys(f).length ? f : void 0;
		}
		return this._map.get(schema);
	}
	has(schema) {
		return this._map.has(schema);
	}
};
function registry() {
	return new $ZodRegistry();
}
(_a = globalThis).__zod_globalRegistry ?? (_a.__zod_globalRegistry = registry());
const globalRegistry = globalThis.__zod_globalRegistry;
//#endregion
//#region node_modules/zod/v4/core/api.js
function snapshotChecks(def) {
	if (def.checks) def.checks = [...def.checks];
	return def;
}
/* @__NO_SIDE_EFFECTS__ */
function _string(Class, params) {
	return new Class(snapshotChecks({
		type: "string",
		...normalizeParams(params)
	}));
}
/* @__NO_SIDE_EFFECTS__ */
function _email(Class, params) {
	return new Class({
		type: "string",
		format: "email",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _guid(Class, params) {
	return new Class({
		type: "string",
		format: "guid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _uuid(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _uuidv4(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		version: "v4",
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _uuidv6(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		version: "v6",
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _uuidv7(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		version: "v7",
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _url(Class, params) {
	return new Class({
		type: "string",
		format: "url",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _emoji(Class, params) {
	return new Class({
		type: "string",
		format: "emoji",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _nanoid(Class, params) {
	return new Class({
		type: "string",
		format: "nanoid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/**
* @deprecated CUID v1 is deprecated by its authors due to information leakage
* (timestamps embedded in the id). Use {@link _cuid2} instead.
* See https://github.com/paralleldrive/cuid.
*/
/* @__NO_SIDE_EFFECTS__ */
function _cuid(Class, params) {
	return new Class({
		type: "string",
		format: "cuid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _cuid2(Class, params) {
	return new Class({
		type: "string",
		format: "cuid2",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _ulid(Class, params) {
	return new Class({
		type: "string",
		format: "ulid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _xid(Class, params) {
	return new Class({
		type: "string",
		format: "xid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _ksuid(Class, params) {
	return new Class({
		type: "string",
		format: "ksuid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _ipv4(Class, params) {
	return new Class({
		type: "string",
		format: "ipv4",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _ipv6(Class, params) {
	return new Class({
		type: "string",
		format: "ipv6",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _cidrv4(Class, params) {
	return new Class({
		type: "string",
		format: "cidrv4",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _cidrv6(Class, params) {
	return new Class({
		type: "string",
		format: "cidrv6",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _base64(Class, params) {
	return new Class({
		type: "string",
		format: "base64",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _base64url(Class, params) {
	return new Class({
		type: "string",
		format: "base64url",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _e164(Class, params) {
	return new Class({
		type: "string",
		format: "e164",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _jwt(Class, params) {
	return new Class({
		type: "string",
		format: "jwt",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _isoDateTime(Class, params) {
	return new Class({
		type: "string",
		format: "datetime",
		check: "string_format",
		offset: false,
		local: false,
		precision: null,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _isoDate(Class, params) {
	return new Class({
		type: "string",
		format: "date",
		check: "string_format",
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _isoTime(Class, params) {
	return new Class({
		type: "string",
		format: "time",
		check: "string_format",
		precision: null,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _isoDuration(Class, params) {
	return new Class({
		type: "string",
		format: "duration",
		check: "string_format",
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _number(Class, params) {
	return new Class(snapshotChecks({
		type: "number",
		checks: [],
		...normalizeParams(params)
	}));
}
/* @__NO_SIDE_EFFECTS__ */
function _int(Class, params) {
	return new Class({
		type: "number",
		check: "number_format",
		abort: false,
		format: "safeint",
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _boolean(Class, params) {
	return new Class({
		type: "boolean",
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _unknown(Class) {
	return new Class({ type: "unknown" });
}
/* @__NO_SIDE_EFFECTS__ */
function _never(Class, params) {
	return new Class({
		type: "never",
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _lt(value, params) {
	return new $ZodCheckLessThan({
		check: "less_than",
		...normalizeParams(params),
		value,
		inclusive: false
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _lte(value, params) {
	return new $ZodCheckLessThan({
		check: "less_than",
		...normalizeParams(params),
		value,
		inclusive: true
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _gt(value, params) {
	return new $ZodCheckGreaterThan({
		check: "greater_than",
		...normalizeParams(params),
		value,
		inclusive: false
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _gte(value, params) {
	return new $ZodCheckGreaterThan({
		check: "greater_than",
		...normalizeParams(params),
		value,
		inclusive: true
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _multipleOf(value, params) {
	return new $ZodCheckMultipleOf({
		check: "multiple_of",
		...normalizeParams(params),
		value
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _maxLength(maximum, params) {
	return new $ZodCheckMaxLength({
		check: "max_length",
		...normalizeParams(params),
		maximum
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _minLength(minimum, params) {
	return new $ZodCheckMinLength({
		check: "min_length",
		...normalizeParams(params),
		minimum
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _length(length, params) {
	return new $ZodCheckLengthEquals({
		check: "length_equals",
		...normalizeParams(params),
		length
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _regex(pattern, params) {
	return new $ZodCheckRegex({
		check: "string_format",
		format: "regex",
		...normalizeParams(params),
		pattern
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _lowercase(params) {
	return new $ZodCheckLowerCase({
		check: "string_format",
		format: "lowercase",
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _uppercase(params) {
	return new $ZodCheckUpperCase({
		check: "string_format",
		format: "uppercase",
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _includes(includes, params) {
	return new $ZodCheckIncludes({
		check: "string_format",
		format: "includes",
		...normalizeParams(params),
		includes
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _startsWith(prefix, params) {
	return new $ZodCheckStartsWith({
		check: "string_format",
		format: "starts_with",
		...normalizeParams(params),
		prefix
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _endsWith(suffix, params) {
	return new $ZodCheckEndsWith({
		check: "string_format",
		format: "ends_with",
		...normalizeParams(params),
		suffix
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _overwrite(tx) {
	return new $ZodCheckOverwrite({
		check: "overwrite",
		tx
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _normalize(form) {
	return /* @__PURE__ */ _overwrite((input) => input.normalize(form));
}
/* @__NO_SIDE_EFFECTS__ */
function _trim() {
	return /* @__PURE__ */ _overwrite((input) => input.trim());
}
/* @__NO_SIDE_EFFECTS__ */
function _toLowerCase() {
	return /* @__PURE__ */ _overwrite((input) => input.toLowerCase());
}
/* @__NO_SIDE_EFFECTS__ */
function _toUpperCase() {
	return /* @__PURE__ */ _overwrite((input) => input.toUpperCase());
}
/* @__NO_SIDE_EFFECTS__ */
function _slugify() {
	return /* @__PURE__ */ _overwrite((input) => slugify(input));
}
/* @__NO_SIDE_EFFECTS__ */
function _array(Class, element, params) {
	return new Class({
		type: "array",
		element,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _refine(Class, fn, _params) {
	return new Class({
		type: "custom",
		check: "custom",
		fn,
		...normalizeParams(_params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _superRefine(fn, params) {
	const ch = /* @__PURE__ */ _check((payload) => {
		payload.addIssue = (issue$2) => {
			if (typeof issue$2 === "string") payload.issues.push(issue(issue$2, payload.value, ch._zod.def));
			else {
				const _issue = issue$2;
				if (_issue.fatal) _issue.continue = false;
				_issue.code ?? (_issue.code = "custom");
				if (!("input" in _issue)) _issue.input = payload.value;
				_issue.inst ?? (_issue.inst = ch);
				_issue.continue ?? (_issue.continue = !ch._zod.def.abort);
				payload.issues.push(issue(_issue));
			}
		};
		return fn(payload.value, payload);
	}, params);
	return ch;
}
/* @__NO_SIDE_EFFECTS__ */
function _check(fn, params) {
	const ch = new $ZodCheck({
		check: "custom",
		...normalizeParams(params)
	});
	ch._zod.check = fn;
	return ch;
}
//#endregion
//#region node_modules/zod/v4/core/to-json-schema.js
function assignProps(target, ...sources) {
	for (const source of sources) for (const key of Reflect.ownKeys(source)) if (Object.prototype.propertyIsEnumerable.call(source, key)) assignProp(target, key, source[key]);
	return target;
}
function initializeContext(params) {
	let target = params?.target ?? "draft-2020-12";
	if (target === "draft-4") target = "draft-04";
	if (target === "draft-7") target = "draft-07";
	return {
		processors: params.processors ?? {},
		metadataRegistry: params?.metadata ?? globalRegistry,
		target,
		unrepresentable: params?.unrepresentable ?? "throw",
		override: params?.override ?? (() => {}),
		io: params?.io ?? "output",
		counter: 0,
		seen: /* @__PURE__ */ new Map(),
		sharedDefsExtractedFor: void 0,
		sharedEmitDoneFor: void 0,
		cycles: params?.cycles ?? "ref",
		reused: params?.reused ?? "inline",
		intersections: [],
		deferred: [],
		external: params?.external ?? void 0
	};
}
/**
* Applies the `unrepresentable` setting at a site that has no JSON Schema equivalent. Throws
* `message` unless the setting (or the handler's return value) says otherwise. Returns `true` if a
* custom JSON Schema was written into `json`, in which case the caller must not write its own.
*/
function handleUnrepresentable(schema, ctx, json, params, message) {
	const result = typeof ctx.unrepresentable === "function" ? ctx.unrepresentable({
		zodSchema: schema,
		path: params.path,
		message
	}) : ctx.unrepresentable;
	if (result === "any") return false;
	if (result === void 0 || result === "throw") throw new Error(message);
	Object.assign(json, result);
	return true;
}
function processSchema(schema, ctx, _params = {
	path: [],
	schemaPath: []
}) {
	var _a;
	const def = schema._zod.def;
	const seen = ctx.seen.get(schema);
	if (seen) {
		seen.count++;
		if (_params.schemaPath.includes(schema)) seen.cycle = _params.path;
		return seen.schema;
	}
	const result = {
		schema: {},
		count: 1,
		cycle: void 0,
		path: _params.path
	};
	ctx.seen.set(schema, result);
	ctx.sharedDefsExtractedFor = void 0;
	ctx.sharedEmitDoneFor = void 0;
	const overrideSchema = schema._zod.toJSONSchema?.();
	if (overrideSchema) result.schema = overrideSchema;
	else {
		const params = {
			..._params,
			schemaPath: [..._params.schemaPath, schema],
			path: _params.path
		};
		if (schema._zod.processJSONSchema) schema._zod.processJSONSchema(ctx, result.schema, params);
		else {
			const _json = result.schema;
			const processor = ctx.processors[def.type];
			if (!processor) throw new Error(`[toJSONSchema]: Non-representable type encountered: ${def.type}`);
			processor(schema, ctx, _json, params);
		}
		const parent = schema._zod.parent;
		if (parent) {
			if (!result.ref) result.ref = parent;
			processSchema(parent, ctx, params);
			ctx.seen.get(parent).isParent = true;
		}
	}
	const meta = ctx.metadataRegistry.get(schema);
	if (meta) assignProps(result.schema, meta);
	if (ctx.io === "input" && isTransforming(schema)) {
		delete result.schema.examples;
		delete result.schema.default;
	}
	if (ctx.io === "input" && "_prefault" in result.schema) (_a = result.schema).default ?? (_a.default = result.schema._prefault);
	delete result.schema._prefault;
	return ctx.seen.get(schema).schema;
}
function encodeJSONPointerSegment(segment) {
	return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}
function extractDefs(ctx, schema) {
	const root = ctx.seen.get(schema);
	if (!root) throw new Error("Unprocessed schema. This is a bug in Zod.");
	if (ctx.external && ctx.sharedDefsExtractedFor === ctx.external) return;
	const idToSchema = /* @__PURE__ */ new Map();
	for (const entry of ctx.seen.entries()) {
		const id = ctx.metadataRegistry.get(entry[0])?.id;
		if (id) {
			const existing = idToSchema.get(id);
			if (existing && existing !== entry[0]) throw new Error(`Duplicate schema id "${id}" detected during JSON Schema conversion. Two different schemas cannot share the same id when converted together.`);
			idToSchema.set(id, entry[0]);
		}
	}
	const makeURI = (entry) => {
		const defsSegment = ctx.target === "draft-2020-12" ? "$defs" : "definitions";
		if (ctx.external) {
			const externalId = ctx.external.registry.get(entry[0])?.id;
			const uriGenerator = ctx.external.uri ?? ((id) => id);
			if (externalId) return { ref: uriGenerator(externalId) };
			const id = entry[1].defId ?? entry[1].schema.id ?? `schema${ctx.counter++}`;
			entry[1].defId = id;
			return {
				defId: id,
				ref: `${uriGenerator("__shared")}#/${defsSegment}/${encodeJSONPointerSegment(id)}`
			};
		}
		const uriPrefix = `#`;
		const defUriPrefix = `${uriPrefix}/${defsSegment}/`;
		if (entry[1] === root && !entry[1].schema.id) return { ref: uriPrefix };
		const defId = entry[1].schema.id ?? `__schema${ctx.counter++}`;
		return {
			defId,
			ref: defUriPrefix + encodeJSONPointerSegment(defId)
		};
	};
	const extractToDef = (entry) => {
		if (entry[1].schema.$ref) return;
		const seen = entry[1];
		const { ref, defId } = makeURI(entry);
		seen.def = { ...seen.schema };
		if (defId) seen.defId = defId;
		const schema = seen.schema;
		for (const key in schema) delete schema[key];
		schema.$ref = ref;
	};
	if (ctx.cycles === "throw") for (const entry of ctx.seen.entries()) {
		const seen = entry[1];
		if (seen.cycle) throw new Error(`Cycle detected: #/${seen.cycle?.join("/")}/<root>

Set the \`cycles\` parameter to \`"ref"\` to resolve cyclical schemas with defs.`);
	}
	for (const entry of ctx.seen.entries()) {
		const seen = entry[1];
		if (schema === entry[0]) {
			extractToDef(entry);
			continue;
		}
		if (ctx.external) {
			const ext = ctx.external.registry.get(entry[0])?.id;
			if (schema !== entry[0] && ext) {
				extractToDef(entry);
				continue;
			}
		}
		if (ctx.metadataRegistry.get(entry[0])?.id) {
			extractToDef(entry);
			continue;
		}
		if (seen.cycle) {
			extractToDef(entry);
			continue;
		}
		if (seen.count > 1) {
			if (ctx.reused === "ref") extractToDef(entry);
		}
	}
	if (ctx.external) ctx.sharedDefsExtractedFor = ctx.external;
}
/** Rewrites `anyOf: [{type: "a"}, {type: "b"}]` to `type: ["a", "b"]`, which every JSON Schema draft treats as equivalent and most consumers render far better for the nullable case. Only branches that are a bare type assertion qualify — anything carrying a constraint, `$ref`, `const` or metadata is left alone. Runs after `flattenRef`, so a branch an override decorated or `$defs` extraction turned into a `$ref` is no longer bare and correctly stays in `anyOf`. `oneOf` is excluded: `integer` and `number` overlap, so "exactly one" and "at least one" are not the same there. OpenAPI 3.0 is excluded: its `type` must be a single string. */
function compactTypeUnion(schema) {
	const options = schema.anyOf;
	if (!Array.isArray(options) || options.length === 0 || schema.type !== void 0) return;
	const types = [];
	for (const option of options) {
		if (!option || typeof option !== "object") return;
		compactTypeUnion(option);
		const keys = Object.keys(option);
		if (keys.length !== 1 || keys[0] !== "type") return;
		const type = option.type;
		for (const member of Array.isArray(type) ? type : [type]) {
			if (typeof member !== "string") return;
			if (!types.includes(member)) types.push(member);
		}
	}
	delete schema.anyOf;
	schema.type = types.length === 1 ? types[0] : types;
}
/** Keywords `foldIntersection` knows how to combine. Anything else — `$ref`, `patternProperties`,
* an annotation like `description` — makes a member unfoldable, so a constraint this does not
* understand leaves the `allOf` alone instead of being silently dropped or misattributed. */
const FOLDABLE_KEYS = new Set([
	"type",
	"properties",
	"required",
	"additionalProperties"
]);
const UNION_KEYS = ["oneOf", "anyOf"];
/** A member's constraint on a key it does not declare itself. A `catchall` states one; `false`, an absent `additionalProperties`, and the empty schema a loose object emits state nothing. */
function undeclaredConstraint(member) {
	const extra = member.additionalProperties;
	if (extra === void 0 || extra === false || typeof extra !== "object" || extra === null) return null;
	return Object.keys(extra).length ? extra : null;
}
/** Combines object members into the single object they describe together, or returns `null` if any of them carries a keyword outside {@link FOLDABLE_KEYS}. */
function foldObjects(members) {
	const objects = [];
	for (const member of members) {
		if (typeof member !== "object" || member.type !== "object") return null;
		for (const key in member) if (!FOLDABLE_KEYS.has(key)) return null;
		objects.push(member);
	}
	const properties = {};
	const required = /* @__PURE__ */ new Set();
	for (const object of objects) {
		for (const key in object.properties) {
			if (Object.prototype.hasOwnProperty.call(properties, key)) continue;
			const parts = [];
			for (const other of objects) {
				const part = other.properties?.[key] ?? undeclaredConstraint(other);
				if (part === null || part === void 0) continue;
				if (!parts.some((seen) => JSON.stringify(seen) === JSON.stringify(part))) parts.push(part);
			}
			assignProp(properties, key, parts.length === 1 ? parts[0] : foldObjects(parts) ?? { allOf: parts });
		}
		for (const key of object.required ?? []) required.add(key);
	}
	const folded = {
		type: "object",
		properties
	};
	if (required.size) folded.required = [...required];
	if (objects.every((object) => object.additionalProperties === false)) folded.additionalProperties = false;
	else {
		const constraints = [];
		for (const object of objects) {
			const constraint = undeclaredConstraint(object);
			if (constraint && !constraints.some((seen) => JSON.stringify(seen) === JSON.stringify(constraint))) constraints.push(constraint);
		}
		if (constraints.length === 1) folded.additionalProperties = constraints[0];
		else if (constraints.length > 1) folded.additionalProperties = { allOf: constraints };
	}
	return folded;
}
/** `additionalProperties` in an `allOf` member sees only that member's own `properties`, so two
* closed object members reject each other's keys and the schema validates nothing. Zod's parser
* pools the key sets instead — `handleIntersectionResults` reports a key as unrecognized only when
* *every* side rejects it — so the emitted schema has to pool them too, and folding the members
* into one object is the encoding that says so on every target.
*
* This runs from `finalize`, after `extractDefs`, which is what keeps it clear of the `$ref`
* machinery: a member extracted into `$defs` is already a `$ref` by now and declines to fold, so it
* keeps its reference and its own closedness rather than being inlined as a stale copy. */
function foldIntersection(json) {
	const allOf = json.allOf;
	if (!Array.isArray(allOf) || allOf.length < 2) return;
	for (const key of FOLDABLE_KEYS) if (key in json) return;
	const unions = allOf.filter((m) => UNION_KEYS.some((k) => Array.isArray(m[k])));
	let folded = null;
	if (!unions.length) folded = foldObjects(allOf);
	else {
		const union = unions[0];
		const keyword = UNION_KEYS.find((k) => Array.isArray(union[k]));
		if (Object.keys(union).length !== 1) return;
		const rest = allOf.filter((m) => m !== union);
		const branches = union[keyword].map((branch) => foldObjects([...rest, branch]));
		if (branches.some((b) => !b)) return;
		folded = { [keyword]: branches };
	}
	if (!folded) return;
	delete json.allOf;
	assignProps(json, folded);
}
function finalize(ctx, schema) {
	const root = ctx.seen.get(schema);
	if (!root) throw new Error("Unprocessed schema. This is a bug in Zod.");
	const flattenRef = (zodSchema) => {
		const seen = ctx.seen.get(zodSchema);
		if (seen.ref === null) return;
		const schema = seen.def ?? seen.schema;
		const _cached = { ...schema };
		const ref = seen.ref;
		seen.ref = null;
		if (ref) {
			flattenRef(ref);
			const refSeen = ctx.seen.get(ref);
			const refSchema = refSeen.schema;
			if (refSchema.$ref && (ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0")) {
				schema.allOf = schema.allOf ?? [];
				schema.allOf.push(refSchema);
			} else assignProps(schema, refSchema);
			assignProps(schema, _cached);
			if (zodSchema._zod.parent === ref) for (const key in schema) {
				if (key === "$ref" || key === "allOf") continue;
				if (!(key in _cached)) delete schema[key];
			}
			if (refSchema.$ref && refSeen.def) for (const key in schema) {
				if (key === "$ref" || key === "allOf") continue;
				if (key in refSeen.def && JSON.stringify(schema[key]) === JSON.stringify(refSeen.def[key])) delete schema[key];
			}
		}
		const parent = zodSchema._zod.parent;
		if (parent && parent !== ref) {
			flattenRef(parent);
			const parentSeen = ctx.seen.get(parent);
			if (parentSeen?.schema.$ref) {
				schema.$ref = parentSeen.schema.$ref;
				if (parentSeen.def) for (const key in schema) {
					if (key === "$ref" || key === "allOf") continue;
					if (key in parentSeen.def && JSON.stringify(schema[key]) === JSON.stringify(parentSeen.def[key])) delete schema[key];
				}
			}
		}
		ctx.override({
			zodSchema,
			jsonSchema: schema,
			path: seen.path ?? []
		});
	};
	if (!ctx.external || ctx.sharedEmitDoneFor !== ctx.external) {
		for (const entry of [...ctx.seen.entries()].reverse()) flattenRef(entry[0]);
		if (ctx.target !== "openapi-3.0") for (const entry of ctx.seen.entries()) compactTypeUnion(entry[1].def ?? entry[1].schema);
		for (const rewrite of ctx.deferred) rewrite();
		if (ctx.intersections.length) {
			const carriers = /* @__PURE__ */ new Map();
			for (const seen of ctx.seen.values()) for (const json of [seen.schema, seen.def]) {
				const allOf = json?.allOf;
				if (!Array.isArray(allOf)) continue;
				const existing = carriers.get(allOf);
				if (existing) existing.push(json);
				else carriers.set(allOf, [json]);
			}
			for (const allOf of ctx.intersections) for (const json of carriers.get(allOf) ?? []) foldIntersection(json);
		}
	}
	const result = {};
	if (ctx.target === "draft-2020-12") result.$schema = "https://json-schema.org/draft/2020-12/schema";
	else if (ctx.target === "draft-07") result.$schema = "http://json-schema.org/draft-07/schema#";
	else if (ctx.target === "draft-04") result.$schema = "http://json-schema.org/draft-04/schema#";
	else if (ctx.target === "openapi-3.0") {}
	if (ctx.external?.uri) {
		const id = ctx.external.registry.get(schema)?.id;
		if (!id) throw new Error("Schema is missing an `id` property");
		result.$id = ctx.external.uri(id);
	}
	assignProps(result, root.defId ? root.schema : root.def ?? root.schema);
	const rootMetaId = ctx.metadataRegistry.get(schema)?.id;
	if (rootMetaId !== void 0 && result.id === rootMetaId) delete result.id;
	const defs = ctx.external?.defs ?? {};
	if (!ctx.external || ctx.sharedEmitDoneFor !== ctx.external) for (const entry of ctx.seen.entries()) {
		const seen = entry[1];
		if (seen.def && seen.defId) {
			if (seen.def.id === seen.defId) delete seen.def.id;
			assignProp(defs, seen.defId, seen.def);
		}
	}
	if (ctx.external) ctx.sharedEmitDoneFor = ctx.external;
	if (ctx.external) {} else if (Object.keys(defs).length > 0) if (ctx.target === "draft-2020-12") result.$defs = defs;
	else result.definitions = defs;
	try {
		const finalized = JSON.parse(JSON.stringify(result));
		Object.defineProperty(finalized, "~standard", {
			value: {
				...schema["~standard"],
				jsonSchema: {
					input: createStandardJSONSchemaMethod(schema, "input", ctx.processors),
					output: createStandardJSONSchemaMethod(schema, "output", ctx.processors)
				}
			},
			enumerable: false,
			writable: false
		});
		return finalized;
	} catch (_err) {
		throw new Error("Error converting schema to JSON.");
	}
}
function isTransforming(_schema, _ctx) {
	const ctx = _ctx ?? { seen: /* @__PURE__ */ new Set() };
	if (ctx.seen.has(_schema)) return false;
	ctx.seen.add(_schema);
	const def = _schema._zod.def;
	if (def.type === "transform") return true;
	if (def.type === "array") return isTransforming(def.element, ctx);
	if (def.type === "set") return isTransforming(def.valueType, ctx);
	if (def.type === "lazy") return isTransforming(def.getter(), ctx);
	if (def.type === "promise" || def.type === "optional" || def.type === "nonoptional" || def.type === "nullable" || def.type === "readonly" || def.type === "default" || def.type === "prefault" || def.type === "catch") return isTransforming(def.innerType, ctx);
	if (def.type === "intersection") return isTransforming(def.left, ctx) || isTransforming(def.right, ctx);
	if (def.type === "record" || def.type === "map") return isTransforming(def.keyType, ctx) || isTransforming(def.valueType, ctx);
	if (def.type === "pipe") {
		if (_schema._zod.traits.has("$ZodCodec")) return true;
		return isTransforming(def.in, ctx) || isTransforming(def.out, ctx);
	}
	if (def.type === "object") {
		for (const key in def.shape) if (isTransforming(def.shape[key], ctx)) return true;
		return false;
	}
	if (def.type === "union") {
		for (const option of def.options) if (isTransforming(option, ctx)) return true;
		return false;
	}
	if (def.type === "tuple") {
		for (const item of def.items) if (isTransforming(item, ctx)) return true;
		if (def.rest && isTransforming(def.rest, ctx)) return true;
		return false;
	}
	return false;
}
/**
* Creates a toJSONSchema method for a schema instance.
* This encapsulates the logic of initializing context, processing, extracting defs, and finalizing.
*/
const createToJSONSchemaMethod = (schema, processors = {}) => (params) => {
	const ctx = initializeContext({
		...params,
		processors
	});
	processSchema(schema, ctx);
	extractDefs(ctx, schema);
	return finalize(ctx, schema);
};
const createStandardJSONSchemaMethod = (schema, io, processors = {}) => (params) => {
	const { libraryOptions, target } = params ?? {};
	const ctx = initializeContext({
		...libraryOptions ?? {},
		target,
		io,
		processors
	});
	processSchema(schema, ctx);
	extractDefs(ctx, schema);
	return finalize(ctx, schema);
};
//#endregion
//#region node_modules/zod/v4/core/json-schema-processors.js
const narrowMin = (agg, key, value) => {
	if (agg[key] === void 0 || value > agg[key]) agg[key] = value;
};
const narrowMax = (agg, key, value) => {
	if (agg[key] === void 0 || value < agg[key]) agg[key] = value;
};
const narrowBoth = (agg, value) => {
	narrowMin(agg, "minimum", value);
	narrowMax(agg, "maximum", value);
};
const addDivisor = (agg, value) => {
	agg.multipleOf ?? (agg.multipleOf = []);
	if (!agg.multipleOf.includes(value)) agg.multipleOf.push(value);
};
const addPattern = (agg, pattern) => {
	agg.patterns ?? (agg.patterns = /* @__PURE__ */ new Set());
	agg.patterns.add(pattern);
};
const intersectMime = (agg, mime) => {
	agg.mime = agg.mime ? agg.mime.filter((m) => mime.includes(m)) : [...mime];
};
const setFormat = (agg, format) => {
	agg.format = format;
	if (format.includes("int")) agg.isInt = true;
};
const minContributor = (agg, def) => narrowMin(agg, "minimum", def.minimum);
const maxContributor = (agg, def) => narrowMax(agg, "maximum", def.maximum);
const formatContributor = (ranges) => (agg, def) => {
	setFormat(agg, def.format);
	const [minimum, maximum] = ranges[def.format];
	narrowMin(agg, "minimum", minimum);
	narrowMax(agg, "maximum", maximum);
};
const contributors = {
	greater_than: (agg, def) => narrowMin(agg, def.inclusive ? "minimum" : "exclusiveMinimum", def.value),
	less_than: (agg, def) => narrowMax(agg, def.inclusive ? "maximum" : "exclusiveMaximum", def.value),
	multiple_of: (agg, def) => addDivisor(agg, def.value),
	number_format: formatContributor(NUMBER_FORMAT_RANGES),
	bigint_format: formatContributor(BIGINT_FORMAT_RANGES),
	min_length: minContributor,
	max_length: maxContributor,
	length_equals: (agg, def) => narrowBoth(agg, def.length),
	min_size: minContributor,
	max_size: maxContributor,
	size_equals: (agg, def) => narrowBoth(agg, def.size),
	string_format: (agg, def) => {
		setFormat(agg, def.format);
		if (def.pattern) addPattern(agg, def.pattern);
		if (def.format === "base64" || def.format === "base64url") agg.contentEncoding = def.format;
		if (def.local || def.precision === -1) agg.laxFormat = true;
	},
	mime_type: (agg, def) => intersectMime(agg, def.mime)
};
function aggregateChecks(schema) {
	const agg = {};
	const def = schema._zod.def;
	const list = schema._zod.traits.has("$ZodCheck") ? [schema, ...def.checks ?? []] : def.checks ?? [];
	for (const ch of list) contributors[ch._zod.def.check]?.(agg, ch._zod.def);
	const bag = schema._zod.bag;
	if (bag.minimum !== void 0) narrowMin(agg, "minimum", bag.minimum);
	if (bag.exclusiveMinimum !== void 0) narrowMin(agg, "exclusiveMinimum", bag.exclusiveMinimum);
	if (bag.maximum !== void 0) narrowMax(agg, "maximum", bag.maximum);
	if (bag.exclusiveMaximum !== void 0) narrowMax(agg, "exclusiveMaximum", bag.exclusiveMaximum);
	if (bag.multipleOf !== void 0) addDivisor(agg, bag.multipleOf);
	if (bag.format !== void 0) {
		agg.format ?? (agg.format = bag.format);
		if (bag.format.includes("int")) agg.isInt = true;
	}
	if (bag.mime) intersectMime(agg, bag.mime);
	for (const pattern of bag.patterns ?? []) addPattern(agg, pattern);
	return agg;
}
const formatMap = {
	guid: "uuid",
	url: "uri",
	datetime: "date-time",
	json_string: "json-string",
	regex: ""
};
const exactPatterns = new Map([[base64Charset, base64], [base64urlCharset, base64url]]);
const exactPattern = (p) => exactPatterns.get(p) ?? p;
const stringProcessor = (schema, ctx, _json, _params) => {
	const json = _json;
	json.type = "string";
	const { minimum, maximum, format, patterns, contentEncoding, laxFormat } = aggregateChecks(schema);
	if (typeof minimum === "number") json.minLength = minimum;
	if (typeof maximum === "number") json.maxLength = maximum;
	if (format) {
		json.format = formatMap[format] ?? format;
		if (json.format === "") delete json.format;
		if (format === "time" || laxFormat) delete json.format;
	}
	if (contentEncoding) json.contentEncoding = contentEncoding;
	if (patterns && patterns.size > 0) {
		const patternList = [...patterns].map(exactPattern);
		if (patternList.length === 1) json.pattern = patternList[0].source;
		else if (patternList.length > 1) json.allOf = [...patternList.map((regex) => ({
			...ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0" ? { type: "string" } : {},
			pattern: regex.source
		}))];
	}
};
const numberProcessor = (schema, ctx, _json, params) => {
	const json = _json;
	const { minimum, maximum, multipleOf, exclusiveMaximum, exclusiveMinimum, isInt } = aggregateChecks(schema);
	json.type = isInt ? "integer" : "number";
	const exMin = typeof exclusiveMinimum === "number" && exclusiveMinimum >= (minimum ?? Number.NEGATIVE_INFINITY);
	const exMax = typeof exclusiveMaximum === "number" && exclusiveMaximum <= (maximum ?? Number.POSITIVE_INFINITY);
	const legacy = ctx.target === "draft-04" || ctx.target === "openapi-3.0";
	if (exMin) if (legacy) {
		json.minimum = exclusiveMinimum;
		json.exclusiveMinimum = true;
	} else json.exclusiveMinimum = exclusiveMinimum;
	else if (typeof minimum === "number") json.minimum = minimum;
	if (exMax) if (legacy) {
		json.maximum = exclusiveMaximum;
		json.exclusiveMaximum = true;
	} else json.exclusiveMaximum = exclusiveMaximum;
	else if (typeof maximum === "number") json.maximum = maximum;
	if (multipleOf) {
		const divisors = /* @__PURE__ */ new Set();
		for (const divisor of multipleOf) if (Number.isFinite(divisor) && divisor !== 0) divisors.add(Math.abs(divisor));
		else handleUnrepresentable(schema, ctx, json, params, `A multipleOf divisor of ${divisor} cannot be represented in JSON Schema`);
		const [first, ...rest] = divisors;
		if (first !== void 0) json.multipleOf = first;
		if (rest.length) json.allOf = [...json.allOf ?? [], ...rest.map((m) => ({ multipleOf: m }))];
	}
};
const booleanProcessor = (_schema, _ctx, json, _params) => {
	json.type = "boolean";
};
const neverProcessor = (_schema, _ctx, json, _params) => {
	json.not = {};
};
const unknownProcessor = (_schema, _ctx, _json, _params) => {};
const enumProcessor = (schema, _ctx, json, _params) => {
	const def = schema._zod.def;
	const values = getEnumValues(def.entries);
	if (values.length === 0) {
		json.not = {};
		return;
	}
	if (values.every((v) => typeof v === "number")) json.type = "number";
	if (values.every((v) => typeof v === "string")) json.type = "string";
	json.enum = values;
};
const literalProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	if (def.values.length === 0) {
		json.not = {};
		return;
	}
	const vals = [];
	for (const val of def.values) if (val === void 0) {
		if (handleUnrepresentable(schema, ctx, json, params, "Literal `undefined` cannot be represented in JSON Schema")) return;
	} else if (typeof val === "bigint") {
		if (handleUnrepresentable(schema, ctx, json, params, "BigInt literals cannot be represented in JSON Schema")) return;
		vals.push(Number(val));
	} else vals.push(val);
	if (vals.length === 0) {} else if (vals.length === 1) {
		const val = vals[0];
		json.type = val === null ? "null" : typeof val;
		if (ctx.target === "draft-04" || ctx.target === "openapi-3.0") json.enum = [val];
		else json.const = val;
	} else {
		if (vals.every((v) => typeof v === "number")) json.type = "number";
		if (vals.every((v) => typeof v === "string")) json.type = "string";
		if (vals.every((v) => typeof v === "boolean")) json.type = "boolean";
		if (vals.every((v) => v === null)) json.type = "null";
		json.enum = vals;
	}
};
const customProcessor = (schema, ctx, json, params) => {
	handleUnrepresentable(schema, ctx, json, params, "Custom types cannot be represented in JSON Schema");
};
const transformProcessor = (schema, ctx, json, params) => {
	handleUnrepresentable(schema, ctx, json, params, "Transforms cannot be represented in JSON Schema");
};
const arrayProcessor = (schema, ctx, _json, params) => {
	const json = _json;
	const def = schema._zod.def;
	const { minimum, maximum } = aggregateChecks(schema);
	if (typeof minimum === "number") json.minItems = minimum;
	if (typeof maximum === "number") json.maxItems = maximum;
	json.type = "array";
	json.items = processSchema(def.element, ctx, {
		...params,
		path: [...params.path, "items"]
	});
};
function inputOptin(schema) {
	const def = schema._zod.def;
	if (def.type === "pipe" && def.in._zod.traits.has("$ZodTransform")) return inputOptin(def.out);
	if (def.type === "catch") return inputOptin(def.innerType);
	return schema._zod.optin;
}
const objectProcessor = (schema, ctx, _json, params) => {
	const json = _json;
	const def = schema._zod.def;
	const shape = def.shape;
	if (Object.getOwnPropertySymbols(shape).length && handleUnrepresentable(schema, ctx, json, params, "Symbol keys cannot be represented in JSON Schema")) return;
	json.type = "object";
	json.properties = {};
	for (const key in shape) assignProp(json.properties, key, processSchema(shape[key], ctx, {
		...params,
		path: [
			...params.path,
			"properties",
			key
		]
	}));
	const requiredKeys = [];
	for (const key of Object.keys(shape)) {
		const field = def.shape[key];
		if (ctx.io === "input" ? inputOptin(field) === void 0 : field._zod.optout === void 0) requiredKeys.push(key);
	}
	if (requiredKeys.length > 0) json.required = requiredKeys;
	if (def.catchall?._zod.def.type === "never") json.additionalProperties = false;
	else if (!def.catchall) {
		if (ctx.io === "output") json.additionalProperties = false;
	} else if (def.catchall) json.additionalProperties = processSchema(def.catchall, ctx, {
		...params,
		path: [...params.path, "additionalProperties"]
	});
};
const unionProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	const isExclusive = def.inclusive === false;
	const options = def.options.map((x, i) => processSchema(x, ctx, {
		...params,
		path: [
			...params.path,
			isExclusive ? "oneOf" : "anyOf",
			i
		]
	}));
	if (isExclusive) json.oneOf = options;
	else json.anyOf = options;
};
const intersectionProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	const a = processSchema(def.left, ctx, {
		...params,
		path: [
			...params.path,
			"allOf",
			0
		]
	});
	const b = processSchema(def.right, ctx, {
		...params,
		path: [
			...params.path,
			"allOf",
			1
		]
	});
	const isSimpleIntersection = (val) => "allOf" in val && Object.keys(val).length === 1;
	const allOf = [...isSimpleIntersection(a) ? a.allOf : [a], ...isSimpleIntersection(b) ? b.allOf : [b]];
	json.allOf = allOf;
	ctx.intersections.push(allOf);
};
/** JSON object keys are always strings, so a numeric record key schema is re-expressed over the
* numeric-string form the record parser matches. Deferred to `finalize`, after the flatten: a key
* behind a wrapper only carries its own `type` before then, and a union key only has its branches.
*
* A numeric bound cannot apply to a property name, so `minimum` and its siblings are dropped rather
* than carried over: keeping them beside `type: "string"` reproduces the match-nothing schema this
* exists to fix. A key that carries one therefore emits wider than the record parses — `z.record(z.number().min(5), V)`
* accepts `"3"` — which is the deliberate trade, since throwing on it would reject an ordinary schema
* outright. */
function stringifyKeyNames(bySchema, json, visited) {
	if (json.$ref) {
		if (visited.has(json)) return json;
		visited.add(json);
		const def = bySchema.get(json)?.def;
		if (!def) return json;
		const inlined = stringifyKeyNames(bySchema, def, visited);
		return inlined === def ? json : inlined;
	}
	for (const keyword of ["anyOf", "oneOf"]) {
		const branches = json[keyword];
		if (!Array.isArray(branches)) continue;
		const mapped = branches.map((branch) => stringifyKeyNames(bySchema, branch, visited));
		if (mapped.some((branch, i) => branch !== branches[i])) json = {
			...json,
			[keyword]: mapped
		};
	}
	const types = Array.isArray(json.type) ? json.type : [json.type];
	const numericType = !types.includes("string") && types.some((t) => t === "number" || t === "integer");
	const values = json.enum ?? (json.const !== void 0 ? [json.const] : void 0);
	if (!numericType && !values?.some((v) => typeof v === "number")) return json;
	const { minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf, format, id, ...rest } = json;
	if (rest.enum) rest.enum = rest.enum.map((v) => typeof v === "number" ? String(v) : v);
	else if (typeof rest.const === "number") rest.const = String(rest.const);
	if (!numericType) return rest;
	rest.type = "string";
	if (!values) rest.pattern = (types.includes("number") ? number$1 : integer).source;
	return rest;
}
/** Every record of one conversion, so the carriers are found in a single pass rather than once per record. */
const pendingRecords = /* @__PURE__ */ new WeakMap();
function rewriteKeyNames(ctx) {
	const bySchema = /* @__PURE__ */ new Map();
	for (const entry of ctx.seen.values()) if (entry.def && !bySchema.has(entry.schema)) bySchema.set(entry.schema, entry);
	const rewrites = /* @__PURE__ */ new Map();
	for (const record of pendingRecords.get(ctx) ?? []) {
		const seen = ctx.seen.get(record);
		const names = (seen?.def ?? seen?.schema)?.propertyNames;
		if (!names || names === true || rewrites.has(names)) continue;
		const rewritten = stringifyKeyNames(bySchema, names, /* @__PURE__ */ new Set());
		if (rewritten !== names) rewrites.set(names, rewritten);
	}
	if (!rewrites.size) return;
	for (const entry of ctx.seen.values()) for (const carrier of [entry.schema, entry.def]) {
		const rewritten = carrier && rewrites.get(carrier.propertyNames);
		if (rewritten) carrier.propertyNames = rewritten;
	}
}
const recordProcessor = (schema, ctx, _json, params) => {
	const json = _json;
	const def = schema._zod.def;
	json.type = "object";
	const keyType = def.keyType;
	const patterns = aggregateChecks(keyType).patterns;
	if (def.mode === "loose" && patterns && patterns.size > 0) {
		const valueSchema = processSchema(def.valueType, ctx, {
			...params,
			path: [
				...params.path,
				"patternProperties",
				"*"
			]
		});
		json.patternProperties = {};
		for (const pattern of patterns) assignProp(json.patternProperties, exactPattern(pattern).source, valueSchema);
	} else {
		if (ctx.target === "draft-07" || ctx.target === "draft-2020-12") {
			json.propertyNames = processSchema(def.keyType, ctx, {
				...params,
				path: [...params.path, "propertyNames"]
			});
			let pending = pendingRecords.get(ctx);
			if (!pending) {
				pending = [];
				pendingRecords.set(ctx, pending);
				ctx.deferred.push(() => rewriteKeyNames(ctx));
			}
			pending.push(schema);
		}
		json.additionalProperties = processSchema(def.valueType, ctx, {
			...params,
			path: [...params.path, "additionalProperties"]
		});
	}
	const keyValues = keyType._zod.values;
	const omittableOnInput = ctx.io === "input" && inputOptin(def.valueType) !== void 0;
	if (keyValues && !def.partial && !omittableOnInput) {
		const validKeyValues = [...keyValues].filter((v) => typeof v === "string" || typeof v === "number");
		if (validKeyValues.length > 0) json.required = validKeyValues.map(String);
	}
};
const nullableProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	const inner = processSchema(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	if (ctx.target === "openapi-3.0") {
		seen.ref = def.innerType;
		json.nullable = true;
	} else json.anyOf = [inner, { type: "null" }];
};
const nonoptionalProcessor = (schema, ctx, _json, params) => {
	const def = schema._zod.def;
	processSchema(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
};
/** Round-trips a default value through JSON so the emitted schema is guaranteed to be valid JSON.
* A BigInt has no reliable encoding, so it goes through `unrepresentable` like any other
* unrepresentable value. Returns a sentinel when the caller must not write a default of its own. */
const UNREPRESENTABLE_DEFAULT = Symbol();
function serializeDefaultValue(value, schema, ctx, json, params) {
	let unrepresentable = false;
	const serialized = JSON.stringify(value, (_, val) => {
		if (typeof val !== "bigint") return val;
		unrepresentable = true;
		return null;
	});
	if (!unrepresentable) return JSON.parse(serialized);
	handleUnrepresentable(schema, ctx, json, params, "BigInt defaults cannot be represented in JSON Schema");
	return UNREPRESENTABLE_DEFAULT;
}
const defaultProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	processSchema(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	const value = serializeDefaultValue(def.defaultValue, schema, ctx, json, params);
	if (value !== UNREPRESENTABLE_DEFAULT) json.default = value;
};
const prefaultProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	processSchema(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	if (ctx.io !== "input") return;
	const value = serializeDefaultValue(def.defaultValue, schema, ctx, json, params);
	if (value !== UNREPRESENTABLE_DEFAULT) json._prefault = value;
};
const catchProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	processSchema(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	let catchValue;
	try {
		catchValue = def.catchValue(void 0);
	} catch {
		handleUnrepresentable(schema, ctx, json, params, "Dynamic catch values are not supported in JSON Schema");
		return;
	}
	json.default = catchValue;
};
const pipeProcessor = (schema, ctx, _json, params) => {
	const def = schema._zod.def;
	const inIsTransform = def.in._zod.traits.has("$ZodTransform");
	const innerType = ctx.io === "input" ? inIsTransform ? def.out : def.in : def.out;
	processSchema(innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = innerType;
};
const readonlyProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	processSchema(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	json.readOnly = true;
};
const optionalProcessor = (schema, ctx, _json, params) => {
	const def = schema._zod.def;
	processSchema(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
};
//#endregion
//#region node_modules/zod/v4/classic/errors.js
const _installedErrorProtos = /* @__PURE__ */ new WeakSet([Object.prototype, Error.prototype]);
function _lazyMethod(proto, key, make) {
	Object.defineProperty(proto, key, {
		configurable: true,
		enumerable: false,
		get() {
			const value = make(this);
			Object.defineProperty(this, key, {
				value,
				configurable: true,
				writable: true
			});
			return value;
		},
		set(value) {
			Object.defineProperty(this, key, {
				value,
				configurable: true,
				writable: true
			});
		}
	});
}
const initializer = (inst, issues) => {
	$ZodError.init(inst, issues);
	inst.name = "ZodError";
	const proto = Object.getPrototypeOf(inst);
	if (_installedErrorProtos.has(proto)) return;
	_installedErrorProtos.add(proto);
	_lazyMethod(proto, "format", (self) => (mapper) => formatError(self, mapper));
	_lazyMethod(proto, "flatten", (self) => (mapper) => flattenError(self, mapper));
	_lazyMethod(proto, "addIssue", (self) => (issue) => {
		self.issues.push(issue);
		self.message = JSON.stringify(self.issues, jsonStringifyReplacer, 2);
	});
	_lazyMethod(proto, "addIssues", (self) => (issues) => {
		self.issues.push(...issues);
		self.message = JSON.stringify(self.issues, jsonStringifyReplacer, 2);
	});
	Object.defineProperty(proto, "isEmpty", {
		configurable: true,
		enumerable: false,
		get() {
			return this.issues.length === 0;
		}
	});
};
const ZodRealError = /* @__PURE__ */ $constructor("ZodError", initializer, void 0, { Parent: Error });
//#endregion
//#region node_modules/zod/v4/classic/parse.js
const parse = /* @__PURE__ */ _parse(ZodRealError);
const parseAsync = /* @__PURE__ */ _parseAsync(ZodRealError);
const safeParse = /* @__PURE__ */ _safeParse(ZodRealError);
const safeParseAsync = /* @__PURE__ */ _safeParseAsync(ZodRealError);
const encode = /* @__PURE__ */ _encode(ZodRealError);
const decode = /* @__PURE__ */ _decode(ZodRealError);
const encodeAsync = /* @__PURE__ */ _encodeAsync(ZodRealError);
const decodeAsync = /* @__PURE__ */ _decodeAsync(ZodRealError);
const safeEncode = /* @__PURE__ */ _safeEncode(ZodRealError);
const safeDecode = /* @__PURE__ */ _safeDecode(ZodRealError);
const safeEncodeAsync = /* @__PURE__ */ _safeEncodeAsync(ZodRealError);
const safeDecodeAsync = /* @__PURE__ */ _safeDecodeAsync(ZodRealError);
//#endregion
//#region node_modules/zod/v4/classic/schemas.js
function _ensureDefaultLocale() {
	if (!globalConfig.localeError) config(en_default());
}
function _ensureDefaultMemoizer() {
	if (!globalConfig.memoizer) config({ memoizer: memoizer() });
}
const ZodType = /* @__PURE__ */ $constructor("ZodType", (inst, def) => {
	_ensureDefaultLocale();
	$ZodType.init(inst, def);
	inst.def = def;
	inst.type = def.type;
	return inst;
}, {
	check(...chks) {
		const def = this.def;
		return this.clone(mergeDefs(def, { checks: [...def.checks ?? [], ...chks.map((ch) => typeof ch === "function" ? { _zod: {
			check: ch,
			def: { check: "custom" },
			onattach: []
		} } : ch)] }), { parent: true });
	},
	with(...chks) {
		return this.check(...chks);
	},
	clone(def, params) {
		return clone(this, def, params);
	},
	brand() {
		return this;
	},
	register(reg, meta) {
		reg.add(this, meta);
		return this;
	},
	refine(check, params) {
		return this.check(refine(check, params));
	},
	superRefine(refinement, params) {
		return this.check(superRefine(refinement, params));
	},
	overwrite(fn) {
		return this.check(/* @__PURE__ */ _overwrite(fn));
	},
	optional() {
		return optional(this);
	},
	exactOptional() {
		return exactOptional(this);
	},
	nullable() {
		return nullable(this);
	},
	nullish() {
		return optional(nullable(this));
	},
	nonoptional(params) {
		return nonoptional(this, params);
	},
	array() {
		return array(this);
	},
	or(arg) {
		return union([this, arg]);
	},
	and(arg) {
		return intersection(this, arg);
	},
	transform(tx) {
		return pipe(this, transform(tx));
	},
	default(d) {
		return _default(this, d);
	},
	prefault(d) {
		return prefault(this, d);
	},
	catch(params) {
		return _catch(this, params);
	},
	pipe(target) {
		return pipe(this, target);
	},
	readonly() {
		return readonly(this);
	},
	describe(description) {
		const cl = this.clone();
		globalRegistry.add(cl, { description });
		return cl;
	},
	meta(...args) {
		if (args.length === 0) return globalRegistry.get(this);
		const cl = this.clone();
		globalRegistry.add(cl, args[0]);
		return cl;
	},
	isOptional() {
		return this.safeParse(void 0).success;
	},
	isNullable() {
		return this.safeParse(null).success;
	},
	apply(fn, ...args) {
		return args.length === 0 ? fn(this) : fn(this, ...args);
	},
	get "~standard"() {
		return hide(this, "~standard", {
			...standardProps(this),
			jsonSchema: {
				input: createStandardJSONSchemaMethod(this, "input"),
				output: createStandardJSONSchemaMethod(this, "output")
			}
		});
	},
	set "~standard"(value) {
		own(this, "~standard", value);
	},
	parse: function _parse(data, params) {
		return parse(this, data, params, { callee: _parse });
	},
	parseAsync: async function _parseAsync(data, params) {
		return await parseAsync(this, data, params, { callee: _parseAsync });
	},
	safeParse(data, params) {
		return safeParse(this, data, params);
	},
	async safeParseAsync(data, params) {
		return safeParseAsync(this, data, params);
	},
	get spa() {
		return this?.safeParseAsync;
	},
	set spa(value) {
		own(this, "spa", value);
	},
	validate(data, params) {
		return validate(this, data, params);
	},
	validateAsync(data, params) {
		return validateAsync$1(this, data, params);
	},
	encode: function _encode(data, params) {
		return encode(this, data, params, { callee: _encode });
	},
	decode: function _decode(data, params) {
		return decode(this, data, params, { callee: _decode });
	},
	encodeAsync: async function _encodeAsync(data, params) {
		return await encodeAsync(this, data, params, { callee: _encodeAsync });
	},
	decodeAsync: async function _decodeAsync(data, params) {
		return await decodeAsync(this, data, params, { callee: _decodeAsync });
	},
	safeEncode(data, params) {
		return safeEncode(this, data, params);
	},
	safeDecode(data, params) {
		return safeDecode(this, data, params);
	},
	async safeEncodeAsync(data, params) {
		return safeEncodeAsync(this, data, params);
	},
	async safeDecodeAsync(data, params) {
		return safeDecodeAsync(this, data, params);
	},
	toJSONSchema(params) {
		return createToJSONSchemaMethod(this, {})(params);
	},
	get description() {
		return globalRegistry.get(this)?.description;
	},
	get _def() {
		return this._zod.def;
	}
});
/** @internal */
const _ZodString = /* @__PURE__ */ $constructor("_ZodString", (inst, def) => {
	$ZodString.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => stringProcessor(inst, ctx, json, params);
}, /* @__PURE__ */ derived({
	format: (inst) => aggregateChecks(inst).format ?? null,
	minLength: (inst) => aggregateChecks(inst).minimum ?? null,
	maxLength: (inst) => aggregateChecks(inst).maximum ?? null
}, {
	regex(...args) {
		return this.check(/* @__PURE__ */ _regex(...args));
	},
	includes(...args) {
		return this.check(/* @__PURE__ */ _includes(...args));
	},
	startsWith(...args) {
		return this.check(/* @__PURE__ */ _startsWith(...args));
	},
	endsWith(...args) {
		return this.check(/* @__PURE__ */ _endsWith(...args));
	},
	min(...args) {
		return this.check(/* @__PURE__ */ _minLength(...args));
	},
	max(...args) {
		return this.check(/* @__PURE__ */ _maxLength(...args));
	},
	length(...args) {
		return this.check(/* @__PURE__ */ _length(...args));
	},
	nonempty(...args) {
		return this.check(/* @__PURE__ */ _minLength(1, ...args));
	},
	lowercase(params) {
		return this.check(/* @__PURE__ */ _lowercase(params));
	},
	uppercase(params) {
		return this.check(/* @__PURE__ */ _uppercase(params));
	},
	trim() {
		return this.check(/* @__PURE__ */ _trim());
	},
	normalize(...args) {
		return this.check(/* @__PURE__ */ _normalize(...args));
	},
	toLowerCase() {
		return this.check(/* @__PURE__ */ _toLowerCase());
	},
	toUpperCase() {
		return this.check(/* @__PURE__ */ _toUpperCase());
	},
	slugify() {
		return this.check(/* @__PURE__ */ _slugify());
	}
}));
const ZodString = /* @__PURE__ */ $constructor("ZodString", (inst, def) => {
	$ZodString.init(inst, def);
	_ZodString.init(inst, def);
}, {
	email(params) {
		return this.check(/* @__PURE__ */ _email(ZodEmail, params));
	},
	url(params) {
		return this.check(/* @__PURE__ */ _url(ZodURL, params));
	},
	jwt(params) {
		return this.check(/* @__PURE__ */ _jwt(ZodJWT, params));
	},
	emoji(params) {
		return this.check(/* @__PURE__ */ _emoji(ZodEmoji, params));
	},
	guid(params) {
		return this.check(/* @__PURE__ */ _guid(ZodGUID, params));
	},
	uuid(params) {
		return this.check(/* @__PURE__ */ _uuid(ZodUUID, params));
	},
	uuidv4(params) {
		return this.check(/* @__PURE__ */ _uuidv4(ZodUUID, params));
	},
	uuidv6(params) {
		return this.check(/* @__PURE__ */ _uuidv6(ZodUUID, params));
	},
	uuidv7(params) {
		return this.check(/* @__PURE__ */ _uuidv7(ZodUUID, params));
	},
	nanoid(params) {
		return this.check(/* @__PURE__ */ _nanoid(ZodNanoID, params));
	},
	cuid(params) {
		return this.check(/* @__PURE__ */ _cuid(ZodCUID, params));
	},
	cuid2(params) {
		return this.check(/* @__PURE__ */ _cuid2(ZodCUID2, params));
	},
	ulid(params) {
		return this.check(/* @__PURE__ */ _ulid(ZodULID, params));
	},
	base64(params) {
		return this.check(/* @__PURE__ */ _base64(ZodBase64, params));
	},
	base64url(params) {
		return this.check(/* @__PURE__ */ _base64url(ZodBase64URL, params));
	},
	xid(params) {
		return this.check(/* @__PURE__ */ _xid(ZodXID, params));
	},
	ksuid(params) {
		return this.check(/* @__PURE__ */ _ksuid(ZodKSUID, params));
	},
	ipv4(params) {
		return this.check(/* @__PURE__ */ _ipv4(ZodIPv4, params));
	},
	ipv6(params) {
		return this.check(/* @__PURE__ */ _ipv6(ZodIPv6, params));
	},
	cidrv4(params) {
		return this.check(/* @__PURE__ */ _cidrv4(ZodCIDRv4, params));
	},
	cidrv6(params) {
		return this.check(/* @__PURE__ */ _cidrv6(ZodCIDRv6, params));
	},
	e164(params) {
		return this.check(/* @__PURE__ */ _e164(ZodE164, params));
	},
	datetime(params) {
		return this.check(/* @__PURE__ */ _isoDateTime(ZodISODateTime, params));
	},
	date(params) {
		return this.check(/* @__PURE__ */ _isoDate(ZodISODate, params));
	},
	time(params) {
		return this.check(/* @__PURE__ */ _isoTime(ZodISOTime, params));
	},
	duration(params) {
		return this.check(/* @__PURE__ */ _isoDuration(ZodISODuration, params));
	}
});
function string(params) {
	return /* @__PURE__ */ _string(ZodString, params);
}
const ZodStringFormat = /* @__PURE__ */ $constructor("ZodStringFormat", (inst, def) => {
	$ZodStringFormat.init(inst, def);
	_ZodString.init(inst, def);
});
const ZodISODateTime = /* @__PURE__ */ $constructor("ZodISODateTime", (inst, def) => {
	$ZodISODateTime.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodISODate = /* @__PURE__ */ $constructor("ZodISODate", (inst, def) => {
	$ZodISODate.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodISOTime = /* @__PURE__ */ $constructor("ZodISOTime", (inst, def) => {
	$ZodISOTime.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodISODuration = /* @__PURE__ */ $constructor("ZodISODuration", (inst, def) => {
	$ZodISODuration.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodEmail = /* @__PURE__ */ $constructor("ZodEmail", (inst, def) => {
	$ZodEmail.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodGUID = /* @__PURE__ */ $constructor("ZodGUID", (inst, def) => {
	$ZodGUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodUUID = /* @__PURE__ */ $constructor("ZodUUID", (inst, def) => {
	$ZodUUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodURL = /* @__PURE__ */ $constructor("ZodURL", (inst, def) => {
	$ZodURL.init(inst, def);
	ZodStringFormat.init(inst, def);
});
function url(params) {
	return /* @__PURE__ */ _url(ZodURL, params);
}
const ZodEmoji = /* @__PURE__ */ $constructor("ZodEmoji", (inst, def) => {
	$ZodEmoji.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodNanoID = /* @__PURE__ */ $constructor("ZodNanoID", (inst, def) => {
	$ZodNanoID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
/**
* @deprecated CUID v1 is deprecated by its authors due to information leakage
* (timestamps embedded in the id). Use {@link ZodCUID2} instead.
* See https://github.com/paralleldrive/cuid.
*/
const ZodCUID = /* @__PURE__ */ $constructor("ZodCUID", (inst, def) => {
	$ZodCUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodCUID2 = /* @__PURE__ */ $constructor("ZodCUID2", (inst, def) => {
	$ZodCUID2.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodULID = /* @__PURE__ */ $constructor("ZodULID", (inst, def) => {
	$ZodULID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodXID = /* @__PURE__ */ $constructor("ZodXID", (inst, def) => {
	$ZodXID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodKSUID = /* @__PURE__ */ $constructor("ZodKSUID", (inst, def) => {
	$ZodKSUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodIPv4 = /* @__PURE__ */ $constructor("ZodIPv4", (inst, def) => {
	$ZodIPv4.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodIPv6 = /* @__PURE__ */ $constructor("ZodIPv6", (inst, def) => {
	$ZodIPv6.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodCIDRv4 = /* @__PURE__ */ $constructor("ZodCIDRv4", (inst, def) => {
	$ZodCIDRv4.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodCIDRv6 = /* @__PURE__ */ $constructor("ZodCIDRv6", (inst, def) => {
	$ZodCIDRv6.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodBase64 = /* @__PURE__ */ $constructor("ZodBase64", (inst, def) => {
	$ZodBase64.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodBase64URL = /* @__PURE__ */ $constructor("ZodBase64URL", (inst, def) => {
	$ZodBase64URL.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodE164 = /* @__PURE__ */ $constructor("ZodE164", (inst, def) => {
	$ZodE164.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodJWT = /* @__PURE__ */ $constructor("ZodJWT", (inst, def) => {
	$ZodJWT.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodNumber = /* @__PURE__ */ $constructor("ZodNumber", (inst, def) => {
	$ZodNumber.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => numberProcessor(inst, ctx, json, params);
	inst.isFinite = true;
}, /* @__PURE__ */ derived({
	minValue: (inst) => {
		const { minimum, exclusiveMinimum } = aggregateChecks(inst);
		return Math.max(minimum ?? Number.NEGATIVE_INFINITY, exclusiveMinimum ?? Number.NEGATIVE_INFINITY);
	},
	maxValue: (inst) => {
		const { maximum, exclusiveMaximum } = aggregateChecks(inst);
		return Math.min(maximum ?? Number.POSITIVE_INFINITY, exclusiveMaximum ?? Number.POSITIVE_INFINITY);
	},
	isInt: (inst) => {
		const { isInt, multipleOf } = aggregateChecks(inst);
		return !!isInt || !!multipleOf?.some(Number.isSafeInteger);
	},
	format: (inst) => aggregateChecks(inst).format ?? null
}, {
	gt(value, params) {
		return this.check(/* @__PURE__ */ _gt(value, params));
	},
	gte(value, params) {
		return this.check(/* @__PURE__ */ _gte(value, params));
	},
	min(value, params) {
		return this.check(/* @__PURE__ */ _gte(value, params));
	},
	lt(value, params) {
		return this.check(/* @__PURE__ */ _lt(value, params));
	},
	lte(value, params) {
		return this.check(/* @__PURE__ */ _lte(value, params));
	},
	max(value, params) {
		return this.check(/* @__PURE__ */ _lte(value, params));
	},
	int(params) {
		return this.check(int(params));
	},
	safe(params) {
		return this.check(int(params));
	},
	positive(params) {
		return this.check(/* @__PURE__ */ _gt(0, params));
	},
	nonnegative(params) {
		return this.check(/* @__PURE__ */ _gte(0, params));
	},
	negative(params) {
		return this.check(/* @__PURE__ */ _lt(0, params));
	},
	nonpositive(params) {
		return this.check(/* @__PURE__ */ _lte(0, params));
	},
	multipleOf(value, params) {
		return this.check(/* @__PURE__ */ _multipleOf(value, params));
	},
	step(value, params) {
		return this.check(/* @__PURE__ */ _multipleOf(value, params));
	},
	finite() {
		return this;
	}
}));
function number(params) {
	return /* @__PURE__ */ _number(ZodNumber, params);
}
const ZodNumberFormat = /* @__PURE__ */ $constructor("ZodNumberFormat", (inst, def) => {
	$ZodNumberFormat.init(inst, def);
	ZodNumber.init(inst, def);
});
function int(params) {
	return /* @__PURE__ */ _int(ZodNumberFormat, params);
}
const ZodBoolean = /* @__PURE__ */ $constructor("ZodBoolean", (inst, def) => {
	$ZodBoolean.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => booleanProcessor(inst, ctx, json, params);
});
function boolean(params) {
	return /* @__PURE__ */ _boolean(ZodBoolean, params);
}
const ZodUnknown = /* @__PURE__ */ $constructor("ZodUnknown", (inst, def) => {
	$ZodUnknown.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => unknownProcessor(inst, ctx, json, params);
});
function unknown() {
	return /* @__PURE__ */ _unknown(ZodUnknown);
}
const ZodNever = /* @__PURE__ */ $constructor("ZodNever", (inst, def) => {
	$ZodNever.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => neverProcessor(inst, ctx, json, params);
});
function never(params) {
	return /* @__PURE__ */ _never(ZodNever, params);
}
const ZodArray = /* @__PURE__ */ $constructor("ZodArray", (inst, def) => {
	_ensureDefaultMemoizer();
	$ZodArray.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => arrayProcessor(inst, ctx, json, params);
	inst.element = def.element;
}, {
	min(n, params) {
		return this.check(/* @__PURE__ */ _minLength(n, params));
	},
	nonempty(params) {
		return this.check(/* @__PURE__ */ _minLength(1, params));
	},
	max(n, params) {
		return this.check(/* @__PURE__ */ _maxLength(n, params));
	},
	length(n, params) {
		return this.check(/* @__PURE__ */ _length(n, params));
	},
	unwrap() {
		return this.element;
	}
});
function array(element, params) {
	return /* @__PURE__ */ _array(ZodArray, element, params);
}
const ZodObject = /* @__PURE__ */ $constructor("ZodObject", (inst, def) => {
	_ensureDefaultMemoizer();
	$ZodObjectJIT.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => objectProcessor(inst, ctx, json, params);
	installLazyProp(inst, "shape", (self) => self._zod.def.shape, false);
}, {
	keyof() {
		return _enum(Object.keys(this._zod.def.shape));
	},
	catchall(catchall) {
		return this.clone(mergeDefs(this._zod.def, { catchall }));
	},
	passthrough() {
		return this.clone(mergeDefs(this._zod.def, { catchall: unknown() }));
	},
	loose() {
		return this.clone(mergeDefs(this._zod.def, { catchall: unknown() }));
	},
	strict() {
		return this.clone(mergeDefs(this._zod.def, { catchall: never() }));
	},
	strip() {
		return this.clone(mergeDefs(this._zod.def, { catchall: void 0 }));
	},
	extend(incoming) {
		return extend(this, incoming);
	},
	safeExtend(incoming) {
		return safeExtend(this, incoming);
	},
	merge(other) {
		return merge(this, other);
	},
	pick(mask) {
		return pick$1(this, mask);
	},
	omit(mask) {
		return omit(this, mask);
	},
	partial(...args) {
		return partial(ZodOptional, this, args[0]);
	},
	exactPartial(...args) {
		return partial(ZodExactOptional, this, args[0], "exactPartial");
	},
	required(...args) {
		return required(ZodNonOptional, this, args[0]);
	}
});
function object(shape, params) {
	return new ZodObject({
		type: "object",
		shape: shape ?? {},
		...normalizeParams(params)
	});
}
const ZodUnion = /* @__PURE__ */ $constructor("ZodUnion", (inst, def) => {
	$ZodUnion.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => unionProcessor(inst, ctx, json, params);
	inst.options = def.options;
});
function union(options, params) {
	return new ZodUnion({
		type: "union",
		options,
		...normalizeParams(params)
	});
}
const ZodIntersection = /* @__PURE__ */ $constructor("ZodIntersection", (inst, def) => {
	$ZodIntersection.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => intersectionProcessor(inst, ctx, json, params);
});
function intersection(left, right) {
	return new ZodIntersection({
		type: "intersection",
		left,
		right
	});
}
const ZodRecord = /* @__PURE__ */ $constructor("ZodRecord", (inst, def) => {
	_ensureDefaultMemoizer();
	$ZodRecord.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => recordProcessor(inst, ctx, json, params);
	inst.keyType = def.keyType;
	inst.valueType = def.valueType;
});
function record(keyType, valueType, params) {
	if (!valueType || !valueType._zod) return new ZodRecord({
		type: "record",
		keyType: string(),
		valueType: keyType,
		...normalizeParams(valueType)
	});
	return new ZodRecord({
		type: "record",
		keyType,
		valueType,
		...normalizeParams(params)
	});
}
const ZodEnum = /* @__PURE__ */ $constructor("ZodEnum", (inst, def) => {
	$ZodEnum.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => enumProcessor(inst, ctx, json, params);
	inst.enum = def.entries;
	inst.options = [...inst._zod.values];
	const keys = new Set(Object.keys(def.entries));
	inst.extract = (values, params) => {
		const newEntries = {};
		for (const value of values) if (keys.has(value)) newEntries[value] = def.entries[value];
		else throw new Error(`Key ${value} not found in enum`);
		return new ZodEnum({
			...def,
			checks: [],
			...normalizeParams(params),
			entries: newEntries
		});
	};
	inst.exclude = (values, params) => {
		const newEntries = { ...def.entries };
		for (const value of values) if (keys.has(value)) delete newEntries[value];
		else throw new Error(`Key ${value} not found in enum`);
		return new ZodEnum({
			...def,
			checks: [],
			...normalizeParams(params),
			entries: newEntries
		});
	};
});
function _enum(values, params) {
	return new ZodEnum({
		type: "enum",
		entries: Array.isArray(values) ? Object.fromEntries(values.map((v) => [v, v])) : values,
		...normalizeParams(params)
	});
}
const ZodLiteral = /* @__PURE__ */ $constructor("ZodLiteral", (inst, def) => {
	$ZodLiteral.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => literalProcessor(inst, ctx, json, params);
	inst.values = new Set(def.values);
	Object.defineProperty(inst, "value", { get() {
		if (def.values.length > 1) throw new Error("This schema contains multiple valid literal values. Use `.values` instead.");
		return def.values[0];
	} });
});
function literal(value, params) {
	return new ZodLiteral({
		type: "literal",
		values: Array.isArray(value) ? value : [value],
		...normalizeParams(params)
	});
}
const ZodTransform = /* @__PURE__ */ $constructor("ZodTransform", (inst, def) => {
	_ensureDefaultMemoizer();
	$ZodTransform.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => transformProcessor(inst, ctx, json, params);
	inst._zod.parse = (payload, _ctx) => {
		if (_ctx.direction === "backward") throw new $ZodEncodeError(inst.constructor.name);
		payload.addIssue = (issue$1) => {
			if (typeof issue$1 === "string") payload.issues.push(issue(issue$1, payload.value, def));
			else {
				const _issue = issue$1;
				if (_issue.fatal) _issue.continue = false;
				_issue.code ?? (_issue.code = "custom");
				if (!("input" in _issue)) _issue.input = payload.value;
				_issue.inst ?? (_issue.inst = inst);
				payload.issues.push(issue(_issue));
			}
		};
		const output = def.transform(payload.value, payload);
		if (output instanceof Promise) return output.then((output) => {
			payload.value = output;
			return payload;
		});
		payload.value = output;
		return payload;
	};
});
function transform(fn) {
	return new ZodTransform({
		type: "transform",
		transform: fn
	});
}
const ZodOptional = /* @__PURE__ */ $constructor("ZodOptional", (inst, def) => {
	$ZodOptional.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function optional(innerType) {
	return new ZodOptional({
		type: "optional",
		innerType
	});
}
const ZodExactOptional = /* @__PURE__ */ $constructor("ZodExactOptional", (inst, def) => {
	$ZodExactOptional.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function exactOptional(innerType) {
	return new ZodExactOptional({
		type: "optional",
		innerType
	});
}
const ZodNullable = /* @__PURE__ */ $constructor("ZodNullable", (inst, def) => {
	$ZodNullable.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => nullableProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function nullable(innerType) {
	return new ZodNullable({
		type: "nullable",
		innerType
	});
}
const ZodDefault = /* @__PURE__ */ $constructor("ZodDefault", (inst, def) => {
	$ZodDefault.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => defaultProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
	inst.removeDefault = inst.unwrap;
});
function _default(innerType, defaultValue) {
	return new ZodDefault({
		type: "default",
		innerType,
		get defaultValue() {
			return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
		}
	});
}
const ZodPrefault = /* @__PURE__ */ $constructor("ZodPrefault", (inst, def) => {
	$ZodPrefault.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => prefaultProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function prefault(innerType, defaultValue) {
	return new ZodPrefault({
		type: "prefault",
		innerType,
		get defaultValue() {
			return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
		}
	});
}
const ZodNonOptional = /* @__PURE__ */ $constructor("ZodNonOptional", (inst, def) => {
	$ZodNonOptional.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => nonoptionalProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function nonoptional(innerType, params) {
	return new ZodNonOptional({
		type: "nonoptional",
		innerType,
		...normalizeParams(params)
	});
}
const ZodCatch = /* @__PURE__ */ $constructor("ZodCatch", (inst, def) => {
	$ZodCatch.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => catchProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
	inst.removeCatch = inst.unwrap;
});
function _catch(innerType, catchValue) {
	return new ZodCatch({
		type: "catch",
		innerType,
		catchValue: typeof catchValue === "function" ? catchValue : constantCatch(catchValue)
	});
}
const ZodPipe = /* @__PURE__ */ $constructor("ZodPipe", (inst, def) => {
	$ZodPipe.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => pipeProcessor(inst, ctx, json, params);
	inst.in = def.in;
	inst.out = def.out;
});
function pipe(in_, out) {
	return new ZodPipe({
		type: "pipe",
		in: in_,
		out
	});
}
const ZodReadonly = /* @__PURE__ */ $constructor("ZodReadonly", (inst, def) => {
	$ZodReadonly.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => readonlyProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function readonly(innerType) {
	return new ZodReadonly({
		type: "readonly",
		innerType
	});
}
const ZodCustom = /* @__PURE__ */ $constructor("ZodCustom", (inst, def) => {
	$ZodCustom.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => customProcessor(inst, ctx, json, params);
});
function refine(fn, _params = {}) {
	return /* @__PURE__ */ _refine(ZodCustom, fn, _params);
}
function superRefine(fn, params) {
	return /* @__PURE__ */ _superRefine(fn, params);
}
//#endregion
//#region node_modules/@agentclientprotocol/sdk/dist/schema-deserialize.js
const skippedItem = Symbol("skippedItem");
function defaultOnError(schema, fallback) {
	return schema.catch(fallback);
}
function requiredDefaultOnError(schema, fallback) {
	const schemaWithCatch = schema.catch(fallback);
	return unknown().transform((value, context) => {
		if (value !== void 0) return schemaWithCatch.parse(value);
		context.addIssue({
			code: "custom",
			message: "Required value is missing"
		});
		return NEVER;
	});
}
/**
* A wire value's discriminant tag, when present as a string. excludeKnownTags
* and preserveCustomPayload are always applied as a pair, so what counts as
* "the tag" is single-sourced here.
*/
function stringTag(value, key) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return;
	const tag = value[key];
	return typeof tag === "string" ? tag : void 0;
}
/**
* Restores the JSON Schema `not` semantics of an extensible union's catch-all
* variant, which the code generator drops: the catch-all formally excludes the
* known variants' discriminant tags, so a malformed known variant (right tag,
* wrong payload) must fail validation instead of parsing as a custom variant.
*
* When this fires inside a union, zod surfaces only this issue (the catch-all
* is the closest match), so the message names the offending tag; the known
* variant's own field-level issues are not available here.
* TODO: re-run the matching known variant's schema and forward its issues so
* consumers can see which field actually failed.
*/
function excludeKnownTags(schema, key, knownTags) {
	return schema.superRefine((value, context) => {
		const tag = stringTag(value, key);
		if (tag !== void 0 && knownTags.includes(tag)) context.addIssue({
			code: "custom",
			path: [key],
			message: `${key} ${JSON.stringify(tag)} is reserved by a known variant, but the value does not match that variant's schema`
		});
	});
}
/**
* Restores the `unevaluatedProperties`/`additionalProperties: true` semantics
* of an extensible union's custom catch-all variant, which the generated
* object schemas drop: a custom variant's extra properties are its payload,
* so after a normal (stripping) parse the raw keys the subschemas didn't
* produce are re-attached. Keys the winning variant evaluated — including
* invalid values salvaged to defaults — keep their parsed results; keys it
* did NOT evaluate arrive raw, even ones a losing variant would have salvaged
* (e.g. a malformed `_meta` on a custom multi-select item).
*/
function preserveCustomPayload(schema, key, knownTags) {
	return unknown().transform((value, context) => {
		const result = schema.safeParse(value);
		if (!result.success) {
			for (const issue of result.error.issues) context.addIssue({
				...issue,
				input: value
			});
			return NEVER;
		}
		const output = result.data;
		const tag = stringTag(value, key);
		if (tag !== void 0 && !knownTags.includes(tag)) {
			const raw = value;
			for (const [property, rawValue] of Object.entries(raw)) {
				if (property === "__proto__") continue;
				if (!Object.hasOwn(output, property)) output[property] = rawValue;
			}
		}
		return output;
	});
}
function vecSkipError(itemSchema) {
	return array(itemSchema.catch(skippedItem)).transform((items) => items.filter((item) => item !== skippedItem));
}
//#endregion
//#region node_modules/@agentclientprotocol/sdk/dist/schema/zod.gen.js
/**
* JSON RPC Request Id
*
* An identifier established by the Client that MUST contain a String, Number, or NULL value if included. If it is not included it is assumed to be a notification. The value SHOULD normally not be Null \[1\] and Numbers SHOULD NOT contain fractional parts \[2\]
*
* The Server MUST reply with the same value in the Response object if included. This member is used to correlate the context between the two objects.
*
* \[1\] The use of Null as a value for the id member in a Request object is discouraged, because this specification uses a value of Null for Responses with an unknown id. Also, because JSON-RPC 1.0 uses an id value of Null for Notifications this could cause confusion in handling.
*
* \[2\] Fractional parts may be problematic, since many decimal fractions cannot be represented exactly as binary fractions.
*/
const zRequestId = union([number(), string()]).nullable();
/**
* A unique identifier for a conversation session between a client and agent.
*
* Sessions maintain their own context, conversation history, and state,
* allowing multiple independent interactions with the same agent.
*
* See protocol docs: [Session ID](https://agentclientprotocol.com/protocol/session-setup#session-id)
*/
const zSessionId = string();
/**
* Request to write content to a text file.
*
* Only available if the client supports the `fs.writeTextFile` capability.
*/
const zWriteTextFileRequest = object({
	sessionId: zSessionId,
	path: string(),
	content: string(),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Request to read content from a text file.
*
* Only available if the client supports the `fs.readTextFile` capability.
*/
const zReadTextFileRequest = object({
	sessionId: zSessionId,
	path: string(),
	line: defaultOnError(int().gte(0).max(4294967295, { error: "Invalid value: Expected uint32 to be <= 4294967295" }).nullish(), () => void 0),
	limit: defaultOnError(int().gte(0).max(4294967295, { error: "Invalid value: Expected uint32 to be <= 4294967295" }).nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Unique identifier for a tool call within a session.
*/
const zToolCallId = string();
/**
* Categories of tools that can be invoked.
*
* Tool kinds help clients choose appropriate icons and optimize how they
* display tool execution progress.
*
* See protocol docs: [Creating](https://agentclientprotocol.com/protocol/tool-calls#creating)
*/
const zToolKind = union([
	literal("read"),
	literal("edit"),
	literal("delete"),
	literal("move"),
	literal("search"),
	literal("execute"),
	literal("think"),
	literal("fetch"),
	literal("switch_mode"),
	literal("other")
]);
/**
* Execution status of a tool call.
*
* Tool calls progress through different statuses during their lifecycle.
*
* See protocol docs: [Status](https://agentclientprotocol.com/protocol/tool-calls#status)
*/
const zToolCallStatus = union([
	literal("pending"),
	literal("in_progress"),
	literal("completed"),
	literal("failed")
]);
/**
* Optional annotations for the client. The client can use annotations to inform how objects are used or displayed
*/
const zAnnotations = object({
	audience: defaultOnError(vecSkipError(union([literal("assistant"), literal("user")])).nullish(), () => void 0),
	lastModified: defaultOnError(string().nullish(), () => void 0),
	priority: defaultOnError(number().nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Text provided to or from an LLM.
*/
const zTextContent = object({
	annotations: defaultOnError(zAnnotations.nullish(), () => void 0),
	text: string(),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* An image provided to or from an LLM.
*/
const zImageContent = object({
	annotations: defaultOnError(zAnnotations.nullish(), () => void 0),
	data: string(),
	mimeType: string(),
	uri: defaultOnError(string().nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Audio provided to or from an LLM.
*/
const zAudioContent = object({
	annotations: defaultOnError(zAnnotations.nullish(), () => void 0),
	data: string(),
	mimeType: string(),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* A resource that the server is capable of reading, included in a prompt or tool call result.
*/
const zResourceLink = object({
	annotations: defaultOnError(zAnnotations.nullish(), () => void 0),
	description: defaultOnError(string().nullish(), () => void 0),
	mimeType: defaultOnError(string().nullish(), () => void 0),
	name: string(),
	size: defaultOnError(number().nullish(), () => void 0),
	title: defaultOnError(string().nullish(), () => void 0),
	uri: string(),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Resource content that can be embedded in a message.
*/
const zEmbeddedResourceResource = union([object({
	mimeType: defaultOnError(string().nullish(), () => void 0),
	text: string(),
	uri: string(),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
}), object({
	blob: string(),
	mimeType: defaultOnError(string().nullish(), () => void 0),
	uri: string(),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
})]);
/**
* The contents of a resource, embedded into a prompt or tool call result.
*/
const zEmbeddedResource = object({
	annotations: defaultOnError(zAnnotations.nullish(), () => void 0),
	resource: zEmbeddedResourceResource,
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Content blocks represent displayable information in the Agent Client Protocol.
*
* They provide a structured way to handle various types of user-facing content—whether
* it's text from language models, images for analysis, or embedded resources for context.
*
* Content blocks appear in:
* - User prompts sent via `session/prompt`
* - Language model output streamed through `session/update` notifications
* - Progress updates and results from tool calls
*
* This structure is compatible with the Model Context Protocol (MCP), enabling
* agents to seamlessly forward content from MCP tool outputs without transformation.
*
* See protocol docs: [Content](https://agentclientprotocol.com/protocol/content)
*/
const zContentBlock = union([
	zTextContent.and(object({ type: literal("text") })),
	zImageContent.and(object({ type: literal("image") })),
	zAudioContent.and(object({ type: literal("audio") })),
	zResourceLink.and(object({ type: literal("resource_link") })),
	zEmbeddedResource.and(object({ type: literal("resource") }))
]);
/**
* Standard content block (text, images, resources).
*/
const zContent = object({
	content: zContentBlock,
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* A diff representing file modifications.
*
* Shows changes to files in a format suitable for display in the client UI.
*
* See protocol docs: [Content](https://agentclientprotocol.com/protocol/tool-calls#content)
*/
const zDiff = object({
	path: string(),
	oldText: defaultOnError(string().nullish(), () => void 0),
	newText: string(),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Typed identifier used for terminal values on the wire.
*/
const zTerminalId = string();
/**
* Embed a terminal created with `terminal/create` by its id.
*
* The terminal must be added before calling `terminal/release`.
*
* See protocol docs: [Terminal](https://agentclientprotocol.com/protocol/terminals)
*/
const zTerminal = object({
	terminalId: zTerminalId,
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Content produced by a tool call.
*
* Tool calls can produce different types of content including
* standard content blocks (text, images) or file diffs.
*
* See protocol docs: [Content](https://agentclientprotocol.com/protocol/tool-calls#content)
*/
const zToolCallContent = union([
	zContent.and(object({ type: literal("content") })),
	zDiff.and(object({ type: literal("diff") })),
	zTerminal.and(object({ type: literal("terminal") }))
]);
/**
* A file location being accessed or modified by a tool.
*
* Enables clients to implement "follow-along" features that track
* which files the agent is working with in real-time.
*
* See protocol docs: [Following the Agent](https://agentclientprotocol.com/protocol/tool-calls#following-the-agent)
*/
const zToolCallLocation = object({
	path: string(),
	line: defaultOnError(int().gte(0).max(4294967295, { error: "Invalid value: Expected uint32 to be <= 4294967295" }).nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* An update to an existing tool call.
*
* Used to report progress and results as tools execute. All fields except
* the tool call ID are optional - only changed fields need to be included.
*
* See protocol docs: [Updating](https://agentclientprotocol.com/protocol/tool-calls#updating)
*/
const zToolCallUpdate = object({
	toolCallId: zToolCallId,
	kind: defaultOnError(zToolKind.nullish(), () => void 0),
	status: defaultOnError(zToolCallStatus.nullish(), () => void 0),
	title: defaultOnError(string().nullish(), () => void 0),
	name: defaultOnError(string().nullish(), () => void 0),
	content: defaultOnError(vecSkipError(zToolCallContent).nullish(), () => void 0),
	locations: defaultOnError(vecSkipError(zToolCallLocation).nullish(), () => void 0),
	rawInput: defaultOnError(unknown().optional(), () => void 0),
	rawOutput: defaultOnError(unknown().optional(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Unique identifier for a permission option.
*/
const zPermissionOptionId = string();
/**
* The type of permission option being presented to the user.
*
* Helps clients choose appropriate icons and UI treatment.
*/
const zPermissionOptionKind = union([
	literal("allow_once"),
	literal("allow_always"),
	literal("reject_once"),
	literal("reject_always")
]);
/**
* Request for user permission to execute a tool call.
*
* Sent when the agent needs authorization before performing a sensitive operation.
*
* See protocol docs: [Requesting Permission](https://agentclientprotocol.com/protocol/tool-calls#requesting-permission)
*/
const zRequestPermissionRequest = object({
	sessionId: zSessionId,
	toolCall: zToolCallUpdate,
	options: array(object({
		optionId: zPermissionOptionId,
		name: string(),
		kind: zPermissionOptionKind,
		_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
	})),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* An environment variable to set when launching an MCP server.
*/
const zEnvVariable = object({
	name: string(),
	value: string(),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Request to create a new terminal and execute a command.
*/
const zCreateTerminalRequest = object({
	sessionId: zSessionId,
	command: string(),
	args: defaultOnError(vecSkipError(string()).optional(), () => []),
	env: defaultOnError(vecSkipError(zEnvVariable).optional(), () => []),
	cwd: defaultOnError(string().nullish(), () => void 0),
	outputByteLimit: defaultOnError(number().nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Request to get the current output and status of a terminal.
*/
const zTerminalOutputRequest = object({
	sessionId: zSessionId,
	terminalId: zTerminalId,
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Request to release a terminal and free its resources.
*/
const zReleaseTerminalRequest = object({
	sessionId: zSessionId,
	terminalId: zTerminalId,
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Request to wait for a terminal command to exit.
*/
const zWaitForTerminalExitRequest = object({
	sessionId: zSessionId,
	terminalId: zTerminalId,
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Request to kill a terminal without releasing it.
*/
const zKillTerminalRequest = object({
	sessionId: zSessionId,
	terminalId: zTerminalId,
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Session-scoped elicitation, optionally tied to a specific tool call.
*
* When `tool_call_id` is set, the elicitation is tied to a specific tool call.
* This is useful when an agent receives an elicitation from an MCP server
* during a tool call and needs to redirect it to the user.
*/
const zElicitationSessionScope = object({
	sessionId: zSessionId,
	toolCallId: defaultOnError(zToolCallId.nullish(), () => void 0)
});
/**
* Request-scoped elicitation, tied to a specific JSON-RPC request outside of a session
* (e.g., during auth/configuration phases before any session is started).
*/
const zElicitationRequestScope = object({ requestId: zRequestId });
/**
* Object schema type.
*/
const zElicitationSchemaType = literal("object");
/**
* String format types for string properties in elicitation schemas.
*/
const zStringFormat = union([
	literal("email"),
	literal("uri"),
	literal("date"),
	literal("date-time")
]);
/**
* A titled enum option with a const value, human-readable title, and optional description.
*/
const zEnumOption = object({
	const: string(),
	title: string(),
	description: defaultOnError(string().nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Schema for string properties in an elicitation form.
*
* When `enum` or `oneOf` is set, this represents a single-select enum
* with `"type": "string"`.
*/
const zStringPropertySchema = object({
	title: defaultOnError(string().nullish(), () => void 0),
	description: defaultOnError(string().nullish(), () => void 0),
	minLength: int().gte(0).max(4294967295, { error: "Invalid value: Expected uint32 to be <= 4294967295" }).nullish(),
	maxLength: int().gte(0).max(4294967295, { error: "Invalid value: Expected uint32 to be <= 4294967295" }).nullish(),
	pattern: string().nullish(),
	format: zStringFormat.nullish(),
	default: defaultOnError(string().nullish(), () => void 0),
	enum: array(string()).nullish(),
	oneOf: array(zEnumOption).nullish(),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Schema for number (floating-point) properties in an elicitation form.
*/
const zNumberPropertySchema = object({
	title: defaultOnError(string().nullish(), () => void 0),
	description: defaultOnError(string().nullish(), () => void 0),
	minimum: number().nullish(),
	maximum: number().nullish(),
	default: defaultOnError(number().nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Schema for integer properties in an elicitation form.
*/
const zIntegerPropertySchema = object({
	title: defaultOnError(string().nullish(), () => void 0),
	description: defaultOnError(string().nullish(), () => void 0),
	minimum: number().nullish(),
	maximum: number().nullish(),
	default: defaultOnError(number().nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Schema for boolean properties in an elicitation form.
*/
const zBooleanPropertySchema = object({
	title: defaultOnError(string().nullish(), () => void 0),
	description: defaultOnError(string().nullish(), () => void 0),
	default: defaultOnError(boolean().nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* String item schema for multi-select enum properties.
*/
const zStringMultiSelectItems = object({
	enum: array(string()),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Items definition for titled multi-select enum properties.
*/
const zTitledMultiSelectItems = object({
	anyOf: array(zEnumOption),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Items for a multi-select (array) property schema.
*
* Custom variants (unknown `type` values) keep their extra
* properties exactly as received; unlike known variants, those keys
* bypass lenient-field salvage and arrive unvalidated.
*/
const zMultiSelectItems = preserveCustomPayload(union([
	zStringMultiSelectItems.and(object({ type: literal("string") })),
	excludeKnownTags(object({ type: string() }), "type", ["string"]),
	zTitledMultiSelectItems
]), "type", ["string"]);
/**
* Schema for multi-select (array) properties in an elicitation form.
*/
const zMultiSelectPropertySchema = object({
	title: defaultOnError(string().nullish(), () => void 0),
	description: defaultOnError(string().nullish(), () => void 0),
	minItems: number().nullish(),
	maxItems: number().nullish(),
	items: zMultiSelectItems,
	default: defaultOnError(vecSkipError(string()).nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Property schema for elicitation form fields.
*
* Each variant corresponds to a JSON Schema `"type"` value.
* Single-select enums use the `String` variant with `enum` or `oneOf` set.
* Multi-select enums use the `Array` variant.
*
* Custom variants (unknown `type` values) keep their extra
* properties exactly as received; unlike known variants, those keys
* bypass lenient-field salvage and arrive unvalidated.
*/
const zElicitationPropertySchema = preserveCustomPayload(union([
	zStringPropertySchema.and(object({ type: literal("string") })),
	zNumberPropertySchema.and(object({ type: literal("number") })),
	zIntegerPropertySchema.and(object({ type: literal("integer") })),
	zBooleanPropertySchema.and(object({ type: literal("boolean") })),
	zMultiSelectPropertySchema.and(object({ type: literal("array") })),
	excludeKnownTags(object({ type: string() }), "type", [
		"array",
		"boolean",
		"integer",
		"number",
		"string"
	])
]), "type", [
	"array",
	"boolean",
	"integer",
	"number",
	"string"
]);
/**
* Type-safe elicitation schema for requesting structured user input.
*
* This represents a JSON Schema object with primitive-typed properties,
* as required by the elicitation specification.
*/
const zElicitationSchema = object({
	type: defaultOnError(zElicitationSchemaType.optional().default("object"), () => "object"),
	title: defaultOnError(string().nullish(), () => void 0),
	properties: record(string(), zElicitationPropertySchema).optional().default({}),
	required: array(string()).nullish(),
	description: defaultOnError(string().nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Form-based elicitation mode where the client renders a form from the provided schema.
*/
const zElicitationFormMode = intersection(union([zElicitationSessionScope, zElicitationRequestScope]), object({ requestedSchema: zElicitationSchema }));
/**
* Unique identifier for an elicitation.
*/
const zElicitationId = string();
/**
* URL-based elicitation mode where the client directs the user to a URL.
*/
const zElicitationUrlMode = intersection(union([zElicitationSessionScope, zElicitationRequestScope]), object({
	elicitationId: zElicitationId,
	url: url()
}));
/**
* Request from the agent to elicit structured user input.
*
* The agent sends this to the client to request information from the user,
* either via a form or by directing them to a URL.
* Elicitations are tied to a session (optionally a tool call) or a request.
*
* Custom variants (unknown `mode` values) keep their extra
* properties exactly as received; unlike known variants, those keys
* bypass lenient-field salvage and arrive unvalidated.
*/
const zCreateElicitationRequest = preserveCustomPayload(intersection(union([
	zElicitationFormMode.and(object({ mode: literal("form") })),
	zElicitationUrlMode.and(object({ mode: literal("url") })),
	excludeKnownTags(intersection(union([zElicitationSessionScope, zElicitationRequestScope]), object({ mode: string() })), "mode", ["form", "url"])
]), object({
	message: string(),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
})), "mode", ["form", "url"]);
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Unique identifier for an MCP server using the ACP transport.
*
* The value is opaque and generated by the ACP component providing the MCP server. It is
* used by `mcp/connect` to route connection requests back to the component that declared the
* server.
*
* @experimental
*/
const zMcpServerAcpId = string();
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Request parameters for `mcp/connect`.
*
* @experimental
*/
const zConnectMcpRequest = object({
	serverId: zMcpServerAcpId,
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* A unique identifier for an active MCP-over-ACP connection.
*
* @experimental
*/
const zMcpConnectionId = string();
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Request parameters for `mcp/message`.
*
* @experimental
*/
const zMessageMcpRequest = object({
	connectionId: zMcpConnectionId,
	method: string(),
	params: record(string(), unknown()).nullish(),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Request parameters for `mcp/disconnect`.
*
* @experimental
*/
const zDisconnectMcpRequest = object({
	connectionId: zMcpConnectionId,
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Allows for sending an arbitrary request that is not part of the ACP spec.
* Extension methods provide a way to add custom functionality while maintaining
* protocol compatibility.
*
* See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)
*/
const zExtRequest = unknown();
object({
	id: zRequestId,
	method: string(),
	params: union([
		zWriteTextFileRequest,
		zReadTextFileRequest,
		zRequestPermissionRequest,
		zCreateTerminalRequest,
		zTerminalOutputRequest,
		zReleaseTerminalRequest,
		zWaitForTerminalExitRequest,
		zKillTerminalRequest,
		zCreateElicitationRequest,
		zConnectMcpRequest,
		zMessageMcpRequest,
		zDisconnectMcpRequest,
		zExtRequest
	]).nullish()
});
/**
* Protocol version identifier.
*
* This version is only bumped for breaking changes.
* Non-breaking changes should be introduced via capabilities.
*/
const zProtocolVersion = int().gte(0).lte(65535);
/**
* Prompt capabilities supported by the agent in `session/prompt` requests.
*
* Baseline agent functionality requires support for [`ContentBlock::Text`]
* and [`ContentBlock::ResourceLink`] in prompt requests.
*
* Other variants must be explicitly opted in to.
* Capabilities for different types of content in prompt requests.
*
* Indicates which content types beyond the baseline (text and resource links)
* the agent can process.
*
* See protocol docs: [Prompt Capabilities](https://agentclientprotocol.com/protocol/initialization#prompt-capabilities)
*/
const zPromptCapabilities = object({
	image: defaultOnError(boolean().optional().default(false), () => false),
	audio: defaultOnError(boolean().optional().default(false), () => false),
	embeddedContext: defaultOnError(boolean().optional().default(false), () => false),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* MCP capabilities supported by the agent
*/
const zMcpCapabilities = object({
	http: defaultOnError(boolean().optional().default(false), () => false),
	sse: defaultOnError(boolean().optional().default(false), () => false),
	acp: defaultOnError(boolean().optional().default(false), () => false),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Capabilities for the `session/list` method.
*
* Supplying `{}` means the agent supports listing sessions.
*/
const zSessionListCapabilities = object({ _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0) });
/**
* Capabilities for the `session/delete` method.
*
* Supplying `{}` means the agent supports deleting sessions from `session/list`.
*/
const zSessionDeleteCapabilities = object({ _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0) });
/**
* Capabilities for additional session directories support.
*
* Supplying `{}` means the agent supports the `additionalDirectories` field on
* supported session lifecycle requests. Agents that also support
* `session/list` may return `SessionInfo.additionalDirectories` to report the
* complete ordered additional-root list associated with a listed session.
*/
const zSessionAdditionalDirectoriesCapabilities = object({ _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0) });
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Capabilities for the `session/fork` method.
*
* Supplying `{}` means the agent supports forking sessions.
*
* @experimental
*/
const zSessionForkCapabilities = object({ _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0) });
/**
* Capabilities for the `session/resume` method.
*
* Supplying `{}` means the agent supports resuming sessions.
*/
const zSessionResumeCapabilities = object({ _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0) });
/**
* Capabilities for the `session/close` method.
*
* Supplying `{}` means the agent supports closing sessions.
*/
const zSessionCloseCapabilities = object({ _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0) });
/**
* Session capabilities supported by the agent.
*
* As a baseline, all Agents **MUST** support `session/new`, `session/prompt`, `session/cancel`, and `session/update`.
*
* Optionally, they **MAY** support other session methods and notifications by specifying additional capabilities.
*
* Note: `session/load` is still handled by the top-level `load_session` capability. This will be unified in future versions of the protocol.
*
* See protocol docs: [Session Capabilities](https://agentclientprotocol.com/protocol/initialization#session-capabilities)
*/
const zSessionCapabilities = object({
	list: defaultOnError(zSessionListCapabilities.nullish(), () => void 0),
	delete: defaultOnError(zSessionDeleteCapabilities.nullish(), () => void 0),
	additionalDirectories: defaultOnError(zSessionAdditionalDirectoriesCapabilities.nullish(), () => void 0),
	fork: defaultOnError(zSessionForkCapabilities.nullish(), () => void 0),
	resume: defaultOnError(zSessionResumeCapabilities.nullish(), () => void 0),
	close: defaultOnError(zSessionCloseCapabilities.nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Authentication-related capabilities supported by the agent.
*/
const zAgentAuthCapabilities = object({
	logout: defaultOnError(object({ _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0) }).nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Provider configuration capabilities supported by the agent.
*
* Supplying `{}` means the agent supports provider configuration methods.
*
* @experimental
*/
const zProvidersCapabilities = object({ _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0) });
/**
* Marker for `document/didOpen` capability support.
*/
const zNesDocumentDidOpenCapabilities = object({ _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0) });
/**
* Capabilities for `document/didChange` events.
*/
const zNesDocumentDidChangeCapabilities = object({
	syncKind: union([literal("full"), literal("incremental")]),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Marker for `document/didClose` capability support.
*/
const zNesDocumentDidCloseCapabilities = object({ _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0) });
/**
* Marker for `document/didSave` capability support.
*/
const zNesDocumentDidSaveCapabilities = object({ _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0) });
/**
* Marker for `document/didFocus` capability support.
*/
const zNesDocumentDidFocusCapabilities = object({ _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0) });
/**
* Event capabilities the agent can consume.
*/
const zNesEventCapabilities = object({
	document: defaultOnError(object({
		didOpen: defaultOnError(zNesDocumentDidOpenCapabilities.nullish(), () => void 0),
		didChange: defaultOnError(zNesDocumentDidChangeCapabilities.nullish(), () => void 0),
		didClose: defaultOnError(zNesDocumentDidCloseCapabilities.nullish(), () => void 0),
		didSave: defaultOnError(zNesDocumentDidSaveCapabilities.nullish(), () => void 0),
		didFocus: defaultOnError(zNesDocumentDidFocusCapabilities.nullish(), () => void 0),
		_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
	}).nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Capabilities for recent files context.
*/
const zNesRecentFilesCapabilities = object({
	maxCount: defaultOnError(int().gte(0).max(4294967295, { error: "Invalid value: Expected uint32 to be <= 4294967295" }).nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Capabilities for related snippets context.
*/
const zNesRelatedSnippetsCapabilities = object({ _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0) });
/**
* Capabilities for edit history context.
*/
const zNesEditHistoryCapabilities = object({
	maxCount: defaultOnError(int().gte(0).max(4294967295, { error: "Invalid value: Expected uint32 to be <= 4294967295" }).nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Capabilities for user actions context.
*/
const zNesUserActionsCapabilities = object({
	maxCount: defaultOnError(int().gte(0).max(4294967295, { error: "Invalid value: Expected uint32 to be <= 4294967295" }).nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Capabilities for open files context.
*/
const zNesOpenFilesCapabilities = object({ _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0) });
/**
* Capabilities for diagnostics context.
*/
const zNesDiagnosticsCapabilities = object({ _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0) });
/**
* Context capabilities the agent wants attached to each suggestion request.
*/
const zNesContextCapabilities = object({
	recentFiles: defaultOnError(zNesRecentFilesCapabilities.nullish(), () => void 0),
	relatedSnippets: defaultOnError(zNesRelatedSnippetsCapabilities.nullish(), () => void 0),
	editHistory: defaultOnError(zNesEditHistoryCapabilities.nullish(), () => void 0),
	userActions: defaultOnError(zNesUserActionsCapabilities.nullish(), () => void 0),
	openFiles: defaultOnError(zNesOpenFilesCapabilities.nullish(), () => void 0),
	diagnostics: defaultOnError(zNesDiagnosticsCapabilities.nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* NES capabilities advertised by the agent during initialization.
*/
const zNesCapabilities = object({
	events: defaultOnError(zNesEventCapabilities.nullish(), () => void 0),
	context: defaultOnError(zNesContextCapabilities.nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* The encoding used for character offsets in positions.
*
* Follows the same conventions as LSP 3.17. The default is UTF-16.
*/
const zPositionEncodingKind = union([
	literal("utf-16"),
	literal("utf-32"),
	literal("utf-8")
]);
/**
* Capabilities supported by the agent.
*
* Advertised during initialization to inform the client about
* available features and content types.
*
* See protocol docs: [Agent Capabilities](https://agentclientprotocol.com/protocol/initialization#agent-capabilities)
*/
const zAgentCapabilities = object({
	loadSession: defaultOnError(boolean().optional().default(false), () => false),
	promptCapabilities: defaultOnError(zPromptCapabilities.optional().default({
		image: false,
		audio: false,
		embeddedContext: false
	}), () => ({
		image: false,
		audio: false,
		embeddedContext: false
	})),
	mcpCapabilities: defaultOnError(zMcpCapabilities.optional().default({
		http: false,
		sse: false,
		acp: false
	}), () => ({
		http: false,
		sse: false,
		acp: false
	})),
	sessionCapabilities: defaultOnError(zSessionCapabilities.optional().default({}), () => ({})),
	auth: defaultOnError(zAgentAuthCapabilities.optional().default({}), () => ({})),
	providers: defaultOnError(zProvidersCapabilities.nullish(), () => void 0),
	nes: defaultOnError(zNesCapabilities.nullish(), () => void 0),
	positionEncoding: defaultOnError(zPositionEncodingKind.nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Typed identifier used for auth method values on the wire.
*/
const zAuthMethodId = string();
/**
* Terminal-based authentication method.
*
* The client runs the configured agent program as a separate interactive
* process for the user to authenticate via a TUI. Agents MUST advertise this
* method only when the client enabled its terminal authentication capability.
* A zero exit status signals success; any other termination signals failure.
* The client MUST NOT pass this method to `authenticate`.
*/
const zAuthMethodTerminal = object({
	id: zAuthMethodId,
	name: string(),
	description: defaultOnError(string().nullish(), () => void 0),
	args: defaultOnError(vecSkipError(string()).optional(), () => []),
	env: defaultOnError(record(string(), string()).optional(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Agent handles authentication itself through `authenticate`.
*
* This is the default authentication method type.
*/
const zAuthMethodAgent = object({
	id: zAuthMethodId,
	name: string(),
	description: defaultOnError(string().nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Describes an available authentication method.
*
* The `type` field acts as the discriminator in the serialized JSON form.
* When no `type` is present, the method is treated as `agent`.
*/
const zAuthMethod = union([zAuthMethodTerminal.and(object({ type: literal("terminal") })), zAuthMethodAgent]);
/**
* Metadata about the implementation of the client or agent.
* Describes the name and version of an ACP implementation, with an optional
* title for UI representation.
*/
const zImplementation = object({
	name: string(),
	title: defaultOnError(string().nullish(), () => void 0),
	version: string(),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Response to the `initialize` method.
*
* Contains the negotiated protocol version and agent capabilities.
*
* See protocol docs: [Initialization](https://agentclientprotocol.com/protocol/initialization)
*/
const zInitializeResponse = object({
	protocolVersion: zProtocolVersion,
	agentCapabilities: defaultOnError(zAgentCapabilities.optional().default({
		loadSession: false,
		promptCapabilities: {
			image: false,
			audio: false,
			embeddedContext: false
		},
		mcpCapabilities: {
			http: false,
			sse: false,
			acp: false
		},
		sessionCapabilities: {},
		auth: {}
	}), () => ({
		loadSession: false,
		promptCapabilities: {
			image: false,
			audio: false,
			embeddedContext: false
		},
		mcpCapabilities: {
			http: false,
			sse: false,
			acp: false
		},
		sessionCapabilities: {},
		auth: {}
	})),
	authMethods: defaultOnError(vecSkipError(zAuthMethod).optional().default([]), () => []),
	agentInfo: defaultOnError(zImplementation.nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Response to the `authenticate` method.
*/
const zAuthenticateResponse = object({ _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0) });
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Unique identifier for a configurable LLM provider.
*
* @experimental
*/
const zProviderId = string();
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Well-known API protocol identifiers for LLM providers.
*
* Agents and clients MUST handle unknown protocol identifiers gracefully.
*
* Protocol names beginning with `_` are free for custom use, like other ACP extension methods.
* Protocol names that do not begin with `_` are reserved for the ACP spec.
*
* @experimental
*/
const zLlmProtocol = union([
	literal("anthropic"),
	literal("openai"),
	literal("azure"),
	literal("vertex"),
	literal("bedrock"),
	string()
]);
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Current effective non-secret routing configuration for a provider.
*
* @experimental
*/
const zProviderCurrentConfig = object({
	apiType: zLlmProtocol,
	baseUrl: string(),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Response to `providers/list`.
*
* @experimental
*/
const zListProvidersResponse = object({
	providers: array(object({
		providerId: zProviderId,
		supported: requiredDefaultOnError(vecSkipError(zLlmProtocol), () => []),
		required: boolean(),
		current: zProviderCurrentConfig.nullish(),
		_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
	})),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Response to `providers/set`.
*
* @experimental
*/
const zSetProviderResponse = object({ _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0) });
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Response to `providers/disable`.
*
* @experimental
*/
const zDisableProviderResponse = object({ _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0) });
/**
* Response to the `logout` method.
*/
const zLogoutResponse = object({ _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0) });
/**
* Unique identifier for a Session Mode.
*/
const zSessionModeId = string();
/**
* The set of modes and the one currently active.
*/
const zSessionModeState = object({
	currentModeId: zSessionModeId,
	availableModes: requiredDefaultOnError(vecSkipError(object({
		id: zSessionModeId,
		name: string(),
		description: defaultOnError(string().nullish(), () => void 0),
		_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
	})), () => []),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Unique identifier for a session configuration option.
*/
const zSessionConfigId = string();
/**
* Semantic category for a session configuration option.
*
* This is intended to help Clients distinguish broadly common selectors (e.g. model selector vs
* session mode selector vs thought/reasoning level) for UX purposes (keyboard shortcuts, icons,
* placement). It MUST NOT be required for correctness. Clients MUST handle missing or unknown
* categories gracefully.
*
* Category names beginning with `_` are free for custom use, like other ACP extension methods.
* Category names that do not begin with `_` are reserved for the ACP spec.
*/
const zSessionConfigOptionCategory = union([
	literal("mode"),
	literal("model"),
	literal("model_config"),
	literal("thought_level"),
	string()
]);
/**
* Unique identifier for a session configuration option value.
*/
const zSessionConfigValueId = string();
/**
* A possible value for a session configuration option.
*/
const zSessionConfigSelectOption = object({
	value: zSessionConfigValueId,
	name: string(),
	description: defaultOnError(string().nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* A group of possible values for a session configuration option.
*/
const zSessionConfigSelectGroup = object({
	group: string(),
	name: string(),
	options: requiredDefaultOnError(vecSkipError(zSessionConfigSelectOption), () => []),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* A single-value selector (dropdown) session configuration option payload.
*/
const zSessionConfigSelect = object({
	currentValue: zSessionConfigValueId,
	options: union([array(zSessionConfigSelectOption), array(zSessionConfigSelectGroup)])
});
/**
* A boolean on/off toggle session configuration option payload.
*/
const zSessionConfigBoolean = object({ currentValue: boolean() });
/**
* A session configuration option selector and its current state.
*/
const zSessionConfigOption = intersection(union([zSessionConfigSelect.and(object({ type: literal("select") })), zSessionConfigBoolean.and(object({ type: literal("boolean") }))]), object({
	id: zSessionConfigId,
	name: string(),
	description: defaultOnError(string().nullish(), () => void 0),
	category: defaultOnError(zSessionConfigOptionCategory.nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
}));
/**
* Response from creating a new session.
*
* See protocol docs: [Creating a Session](https://agentclientprotocol.com/protocol/session-setup#creating-a-session)
*/
const zNewSessionResponse = object({
	sessionId: zSessionId,
	modes: defaultOnError(zSessionModeState.nullish(), () => void 0),
	configOptions: defaultOnError(vecSkipError(zSessionConfigOption).nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Response from loading an existing session.
*/
const zLoadSessionResponse = object({
	modes: defaultOnError(zSessionModeState.nullish(), () => void 0),
	configOptions: defaultOnError(vecSkipError(zSessionConfigOption).nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Response from listing sessions.
*/
const zListSessionsResponse = object({
	sessions: requiredDefaultOnError(vecSkipError(object({
		sessionId: zSessionId,
		cwd: string(),
		additionalDirectories: defaultOnError(vecSkipError(string()).optional(), () => []),
		title: defaultOnError(string().nullish(), () => void 0),
		updatedAt: defaultOnError(string().nullish(), () => void 0),
		_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
	})), () => []),
	nextCursor: defaultOnError(string().nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Response from deleting a session.
*/
const zDeleteSessionResponse = object({ _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0) });
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Response from forking an existing session.
*
* @experimental
*/
const zForkSessionResponse = object({
	sessionId: zSessionId,
	modes: defaultOnError(zSessionModeState.nullish(), () => void 0),
	configOptions: defaultOnError(vecSkipError(zSessionConfigOption).nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Response from resuming an existing session.
*/
const zResumeSessionResponse = object({
	modes: defaultOnError(zSessionModeState.nullish(), () => void 0),
	configOptions: defaultOnError(vecSkipError(zSessionConfigOption).nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Response from closing a session.
*/
const zCloseSessionResponse = object({ _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0) });
/**
* Response to `session/set_mode` method.
*/
const zSetSessionModeResponse = object({ _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0) });
/**
* Response to `session/set_config_option` method.
*/
const zSetSessionConfigOptionResponse = object({
	configOptions: requiredDefaultOnError(vecSkipError(zSessionConfigOption), () => []),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Response from processing a user prompt.
*
* See protocol docs: [Check for Completion](https://agentclientprotocol.com/protocol/prompt-turn#4-check-for-completion)
*/
const zPromptResponse = object({
	stopReason: union([
		literal("end_turn"),
		literal("max_tokens"),
		literal("max_turn_requests"),
		literal("refusal"),
		literal("cancelled")
	]),
	usage: defaultOnError(object({
		totalTokens: number(),
		inputTokens: number(),
		outputTokens: number(),
		thoughtTokens: defaultOnError(number().nullish(), () => void 0),
		cachedReadTokens: defaultOnError(number().nullish(), () => void 0),
		cachedWriteTokens: defaultOnError(number().nullish(), () => void 0),
		_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
	}).nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Response to `nes/start`.
*/
const zStartNesResponse = object({
	sessionId: zSessionId,
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Unique identifier for a next edit suggestion.
*/
const zNesSuggestionId = string();
/**
* A zero-based position in a text document.
*
* The meaning of `character` depends on the negotiated position encoding.
*/
const zPosition = object({
	line: int().gte(0).max(4294967295, { error: "Invalid value: Expected uint32 to be <= 4294967295" }),
	character: int().gte(0).max(4294967295, { error: "Invalid value: Expected uint32 to be <= 4294967295" }),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* A range in a text document, expressed as start and end positions.
*/
const zRange = object({
	start: zPosition,
	end: zPosition,
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* A text edit within a suggestion.
*/
const zNesTextEdit = object({
	range: zRange,
	newText: string(),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* A text edit suggestion.
*/
const zNesEditSuggestion = object({
	id: zNesSuggestionId,
	uri: string(),
	edits: array(zNesTextEdit),
	cursorPosition: defaultOnError(zPosition.nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* A jump-to-location suggestion.
*/
const zNesJumpSuggestion = object({
	id: zNesSuggestionId,
	uri: string(),
	position: zPosition,
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* A rename symbol suggestion.
*/
const zNesRenameSuggestion = object({
	id: zNesSuggestionId,
	uri: string(),
	position: zPosition,
	newName: string(),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* A search-and-replace suggestion.
*/
const zNesSearchAndReplaceSuggestion = object({
	id: zNesSuggestionId,
	uri: string(),
	search: string(),
	replace: string(),
	isRegex: boolean().nullish(),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Response to `nes/suggest`.
*/
const zSuggestNesResponse = object({
	suggestions: array(union([
		zNesEditSuggestion.and(object({ kind: literal("edit") })),
		zNesJumpSuggestion.and(object({ kind: literal("jump") })),
		zNesRenameSuggestion.and(object({ kind: literal("rename") })),
		zNesSearchAndReplaceSuggestion.and(object({ kind: literal("searchAndReplace") }))
	])),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Response from closing an NES session.
*/
const zCloseNesResponse = object({ _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0) });
/**
* Allows for sending an arbitrary response to an [`ExtRequest`] that is not part of the ACP spec.
* Extension methods provide a way to add custom functionality while maintaining
* protocol compatibility.
*
* See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)
*/
const zExtResponse = unknown();
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Response to `mcp/message`.
*
* This is the inner MCP response result payload. Any JSON value is valid.
*
* @experimental
*/
const zMessageMcpResponse = unknown();
/**
* JSON-RPC error object.
*
* Represents an error that occurred during method execution, following the
* JSON-RPC 2.0 error object specification with optional additional data.
*
* See protocol docs: [JSON-RPC Error Object](https://www.jsonrpc.org/specification#error_object)
*/
const zError = object({
	code: union([
		literal(-32700),
		literal(-32600),
		literal(-32601),
		literal(-32602),
		literal(-32603),
		literal(-32800),
		literal(-32e3),
		literal(-32002),
		int().min(-2147483648, { error: "Invalid value: Expected int32 to be >= -2147483648" }).max(2147483647, { error: "Invalid value: Expected int32 to be <= 2147483647" })
	]),
	message: string(),
	data: defaultOnError(unknown().optional(), () => void 0)
});
union([object({
	id: zRequestId,
	result: union([
		zInitializeResponse,
		zAuthenticateResponse,
		zListProvidersResponse,
		zSetProviderResponse,
		zDisableProviderResponse,
		zLogoutResponse,
		zNewSessionResponse,
		zLoadSessionResponse,
		zListSessionsResponse,
		zDeleteSessionResponse,
		zForkSessionResponse,
		zResumeSessionResponse,
		zCloseSessionResponse,
		zSetSessionModeResponse,
		zSetSessionConfigOptionResponse,
		zPromptResponse,
		zStartNesResponse,
		zSuggestNesResponse,
		zCloseNesResponse,
		zExtResponse,
		zMessageMcpResponse
	])
}), object({
	id: zRequestId,
	error: zError
})]);
/**
* A streamed item of content
*/
const zContentChunk = object({
	content: zContentBlock,
	messageId: defaultOnError(string().nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Represents a tool call that the language model has requested.
*
* Tool calls are actions that the agent executes on behalf of the language model,
* such as reading files, executing code, or fetching data from external sources.
*
* See protocol docs: [Tool Calls](https://agentclientprotocol.com/protocol/tool-calls)
*/
const zToolCall = object({
	toolCallId: zToolCallId,
	title: string(),
	name: defaultOnError(string().nullish(), () => void 0),
	kind: defaultOnError(zToolKind.optional(), () => void 0),
	status: defaultOnError(zToolCallStatus.optional(), () => void 0),
	content: defaultOnError(vecSkipError(zToolCallContent).optional(), () => []),
	locations: defaultOnError(vecSkipError(zToolCallLocation).optional(), () => []),
	rawInput: defaultOnError(unknown().optional(), () => void 0),
	rawOutput: defaultOnError(unknown().optional(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Priority levels for plan entries.
*
* Used to indicate the relative importance or urgency of different
* tasks in the execution plan.
* See protocol docs: [Plan Entries](https://agentclientprotocol.com/protocol/agent-plan#plan-entries)
*/
const zPlanEntryPriority = union([
	literal("high"),
	literal("medium"),
	literal("low")
]);
/**
* Status of a plan entry in the execution flow.
*
* Tracks the lifecycle of each task from planning through completion.
* See protocol docs: [Plan Entries](https://agentclientprotocol.com/protocol/agent-plan#plan-entries)
*/
const zPlanEntryStatus = union([
	literal("pending"),
	literal("in_progress"),
	literal("completed")
]);
/**
* A single entry in the execution plan.
*
* Represents a task or goal that the assistant intends to accomplish
* as part of fulfilling the user's request.
* See protocol docs: [Plan Entries](https://agentclientprotocol.com/protocol/agent-plan#plan-entries)
*/
const zPlanEntry = object({
	content: string(),
	priority: zPlanEntryPriority,
	status: zPlanEntryStatus,
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* An execution plan for accomplishing complex tasks.
*
* Plans consist of multiple entries representing individual tasks or goals.
* Agents report plans to clients to provide visibility into their execution strategy.
* Plans can evolve during execution as the agent discovers new requirements or completes tasks.
*
* See protocol docs: [Agent Plan](https://agentclientprotocol.com/protocol/agent-plan)
*/
const zPlan = object({
	entries: requiredDefaultOnError(vecSkipError(zPlanEntry), () => []),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Unique identifier for a plan within a session.
*
* @experimental
*/
const zPlanId = string();
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* A plan represented as structured entries.
*
* @experimental
*/
const zPlanItems = object({
	planId: zPlanId,
	entries: requiredDefaultOnError(vecSkipError(zPlanEntry), () => []),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* A plan represented by a file URI.
*
* @experimental
*/
const zPlanFile = object({
	planId: zPlanId,
	uri: string(),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* A plan represented as raw markdown content.
*
* @experimental
*/
const zPlanMarkdown = object({
	planId: zPlanId,
	content: string(),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* A content update for a plan identified by ID.
*
* @experimental
*/
const zPlanUpdate = object({
	plan: union([
		zPlanItems.and(object({ type: literal("items") })),
		zPlanFile.and(object({ type: literal("file") })),
		zPlanMarkdown.and(object({ type: literal("markdown") }))
	]),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Removal notice for a plan identified by ID.
*
* @experimental
*/
const zPlanRemoved = object({
	planId: zPlanId,
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* unstructured
*
* All text that was typed after the command name is provided as input.
*/
const zAvailableCommandInput = object({
	hint: string(),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Available commands are ready or have changed
*/
const zAvailableCommandsUpdate = object({
	availableCommands: requiredDefaultOnError(vecSkipError(object({
		name: string(),
		description: string(),
		input: defaultOnError(zAvailableCommandInput.nullish(), () => void 0),
		_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
	})), () => []),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* The current mode of the session has changed
*
* See protocol docs: [Session Modes](https://agentclientprotocol.com/protocol/session-modes)
*/
const zCurrentModeUpdate = object({
	currentModeId: zSessionModeId,
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Session configuration options have been updated.
*/
const zConfigOptionUpdate = object({
	configOptions: requiredDefaultOnError(vecSkipError(zSessionConfigOption), () => []),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Update to session metadata. All fields are optional to support partial updates.
*
* Agents send this notification to update session information like title or custom metadata.
* This allows clients to display dynamic session names and track session state changes.
*/
const zSessionInfoUpdate = object({
	title: defaultOnError(string().nullish(), () => void 0),
	updatedAt: defaultOnError(string().nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Cost information for a session.
*/
const zCost = object({
	amount: number(),
	currency: string(),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Context window and cost update for a session.
*/
const zUsageUpdate = object({
	used: number(),
	size: number(),
	cost: defaultOnError(zCost.nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Unique identifier for a context compaction within a session.
*
* @experimental
*/
const zCompactionId = string();
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* A context compaction upsert. The first update fixes the compaction's
* timeline position. Later updates with the same ID patch that entity in place.
* Agents MUST only send this update when the Client advertised
* [`ClientSessionCapabilities::compaction`].
*
* `summary`, `error`, and `_meta` have patch semantics: omission leaves the
* stored value unchanged, `null` clears it, and a concrete value replaces it.
* `summary: []` also clears the retained summary. A non-empty summary is only
* valid with `completed`; `error` is only valid with `failed`.
*
* @experimental
*/
const zCompactionUpdate = object({
	compactionId: zCompactionId,
	status: union([
		literal("in_progress"),
		literal("completed"),
		literal("failed"),
		literal("cancelled"),
		string()
	]),
	summary: defaultOnError(vecSkipError(zContentBlock).nullish(), () => void 0),
	error: defaultOnError(string().nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* A content block appended to the retained summary of an in-progress
* compaction. Agents send chunks only after an `in_progress` update and before
* the terminal update for the same ID. Agents MUST only send this update when
* the Client advertised [`ClientSessionCapabilities::compaction`].
*
* @experimental
*/
const zCompactionSummaryChunk = object({
	compactionId: zCompactionId,
	content: zContentBlock,
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Notification containing a session update from the agent.
*
* Used to stream real-time progress and results during prompt processing.
*
* See protocol docs: [Agent Reports Output](https://agentclientprotocol.com/protocol/prompt-turn#3-agent-reports-output)
*/
const zSessionNotification = object({
	sessionId: zSessionId,
	update: union([
		zContentChunk.and(object({ sessionUpdate: literal("user_message_chunk") })),
		zContentChunk.and(object({ sessionUpdate: literal("agent_message_chunk") })),
		zContentChunk.and(object({ sessionUpdate: literal("agent_thought_chunk") })),
		zToolCall.and(object({ sessionUpdate: literal("tool_call") })),
		zToolCallUpdate.and(object({ sessionUpdate: literal("tool_call_update") })),
		zPlan.and(object({ sessionUpdate: literal("plan") })),
		zPlanUpdate.and(object({ sessionUpdate: literal("plan_update") })),
		zPlanRemoved.and(object({ sessionUpdate: literal("plan_removed") })),
		zAvailableCommandsUpdate.and(object({ sessionUpdate: literal("available_commands_update") })),
		zCurrentModeUpdate.and(object({ sessionUpdate: literal("current_mode_update") })),
		zConfigOptionUpdate.and(object({ sessionUpdate: literal("config_option_update") })),
		zSessionInfoUpdate.and(object({ sessionUpdate: literal("session_info_update") })),
		zUsageUpdate.and(object({ sessionUpdate: literal("usage_update") })),
		zCompactionUpdate.and(object({ sessionUpdate: literal("compaction_update") })),
		zCompactionSummaryChunk.and(object({ sessionUpdate: literal("compaction_summary_chunk") }))
	]),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Notification sent by the agent when a URL-based elicitation is complete.
*/
const zCompleteElicitationNotification = object({
	elicitationId: zElicitationId,
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Notification parameters for `mcp/message`.
*
* This is used when the wrapped MCP message is a notification and the outer JSON-RPC
* envelope has no `id`.
*
* @experimental
*/
const zMessageMcpNotification = object({
	connectionId: zMcpConnectionId,
	method: string(),
	params: defaultOnError(record(string(), unknown()).nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Allows the Agent to send an arbitrary notification that is not part of the ACP spec.
* Extension notifications provide a way to send one-way messages for custom functionality
* while maintaining protocol compatibility.
*
* See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)
*/
const zExtNotification = unknown();
object({
	method: string(),
	params: union([
		zSessionNotification,
		zCompleteElicitationNotification,
		zMessageMcpNotification,
		zExtNotification
	]).nullish()
});
/**
* File system capabilities that a client may support.
*
* See protocol docs: [FileSystem](https://agentclientprotocol.com/protocol/initialization#filesystem)
*/
const zFileSystemCapabilities = object({
	readTextFile: defaultOnError(boolean().optional().default(false), () => false),
	writeTextFile: defaultOnError(boolean().optional().default(false), () => false),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Client support for ID-addressed context compaction updates.
*
* @experimental
*/
const zCompactionCapabilities = record(string(), unknown());
/**
* Session configuration option capabilities supported by the client.
*/
const zSessionConfigOptionsCapabilities = object({
	boolean: defaultOnError(object({ _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0) }).nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Session-related capabilities supported by the client.
*/
const zClientSessionCapabilities = object({
	compaction: defaultOnError(zCompactionCapabilities.nullish(), () => void 0),
	configOptions: defaultOnError(zSessionConfigOptionsCapabilities.nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Capabilities for receiving `plan_update` and `plan_removed` session updates.
*
* @experimental
*/
const zPlanCapabilities = object({ _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0) });
/**
* Authentication capabilities supported by the client.
*
* Advertised during initialization to inform the agent which authentication
* method types the client can handle. This governs opt-in types that require
* additional client-side support.
*/
const zAuthCapabilities = object({
	terminal: defaultOnError(boolean().optional().default(false), () => false),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Form-based elicitation capabilities.
*
* Supplying `{}` means the client supports form-based elicitation.
*/
const zElicitationFormCapabilities = object({ _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0) });
/**
* URL-based elicitation capabilities.
*
* Supplying `{}` means the client supports URL-based elicitation.
*/
const zElicitationUrlCapabilities = object({ _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0) });
/**
* Elicitation capabilities supported by the client.
*/
const zElicitationCapabilities = object({
	form: defaultOnError(zElicitationFormCapabilities.nullish(), () => void 0),
	url: defaultOnError(zElicitationUrlCapabilities.nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Marker for jump suggestion support.
*/
const zNesJumpCapabilities = object({ _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0) });
/**
* Marker for rename suggestion support.
*/
const zNesRenameCapabilities = object({ _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0) });
/**
* Marker for search and replace suggestion support.
*/
const zNesSearchAndReplaceCapabilities = object({ _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0) });
/**
* NES capabilities advertised by the client during initialization.
*/
const zClientNesCapabilities = object({
	jump: defaultOnError(zNesJumpCapabilities.nullish(), () => void 0),
	rename: defaultOnError(zNesRenameCapabilities.nullish(), () => void 0),
	searchAndReplace: defaultOnError(zNesSearchAndReplaceCapabilities.nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Request parameters for the initialize method.
*
* Sent by the client to establish connection and negotiate capabilities.
*
* See protocol docs: [Initialization](https://agentclientprotocol.com/protocol/initialization)
*/
const zInitializeRequest = object({
	protocolVersion: zProtocolVersion,
	clientCapabilities: defaultOnError(object({
		fs: defaultOnError(zFileSystemCapabilities.optional().default({
			readTextFile: false,
			writeTextFile: false
		}), () => ({
			readTextFile: false,
			writeTextFile: false
		})),
		terminal: defaultOnError(boolean().optional().default(false), () => false),
		session: defaultOnError(zClientSessionCapabilities.nullish(), () => void 0),
		plan: defaultOnError(zPlanCapabilities.nullish(), () => void 0),
		auth: defaultOnError(zAuthCapabilities.optional().default({ terminal: false }), () => ({ terminal: false })),
		elicitation: defaultOnError(zElicitationCapabilities.nullish(), () => void 0),
		nes: defaultOnError(zClientNesCapabilities.nullish(), () => void 0),
		positionEncodings: defaultOnError(vecSkipError(zPositionEncodingKind).optional(), () => []),
		_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
	}).optional().default({
		fs: {
			readTextFile: false,
			writeTextFile: false
		},
		terminal: false,
		auth: { terminal: false }
	}), () => ({
		fs: {
			readTextFile: false,
			writeTextFile: false
		},
		terminal: false,
		auth: { terminal: false }
	})),
	clientInfo: defaultOnError(zImplementation.nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Request parameters for the authenticate method.
*
* Specifies which authentication method to use.
*/
const zAuthenticateRequest = object({
	methodId: zAuthMethodId,
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Request parameters for `providers/list`.
*
* @experimental
*/
const zListProvidersRequest = object({ _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0) });
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Request parameters for `providers/set`.
*
* Replaces the full configuration for one provider ID.
*
* @experimental
*/
const zSetProviderRequest = object({
	providerId: zProviderId,
	apiType: zLlmProtocol,
	baseUrl: string(),
	headers: record(string(), string()).optional(),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Request parameters for `providers/disable`.
*
* @experimental
*/
const zDisableProviderRequest = object({
	providerId: zProviderId,
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Request parameters for the logout method.
*
* Terminates the current authenticated session.
*/
const zLogoutRequest = object({ _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0) });
/**
* An HTTP header to set when making requests to the MCP server.
*/
const zHttpHeader = object({
	name: string(),
	value: string(),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* HTTP transport configuration for MCP.
*/
const zMcpServerHttp = object({
	name: string(),
	url: string(),
	headers: array(zHttpHeader),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* SSE transport configuration for MCP.
*/
const zMcpServerSse = object({
	name: string(),
	url: string(),
	headers: array(zHttpHeader),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* ACP transport configuration for MCP.
*
* The MCP server is provided by an ACP component and communicates over the ACP channel
* using `mcp/connect`, `mcp/message`, and `mcp/disconnect`.
*
* @experimental
*/
const zMcpServerAcp = object({
	name: string(),
	serverId: zMcpServerAcpId,
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Stdio transport configuration for MCP.
*/
const zMcpServerStdio = object({
	name: string(),
	command: string(),
	args: array(string()),
	env: array(zEnvVariable),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Configuration for connecting to an MCP (Model Context Protocol) server.
*
* MCP servers provide tools and context that the agent can use when
* processing prompts.
*
* See protocol docs: [MCP Servers](https://agentclientprotocol.com/protocol/session-setup#mcp-servers)
*/
const zMcpServer = union([
	zMcpServerHttp.and(object({ type: literal("http") })),
	zMcpServerSse.and(object({ type: literal("sse") })),
	zMcpServerAcp.and(object({ type: literal("acp") })),
	zMcpServerStdio
]);
/**
* Request parameters for creating a new session.
*
* See protocol docs: [Creating a Session](https://agentclientprotocol.com/protocol/session-setup#creating-a-session)
*/
const zNewSessionRequest = object({
	cwd: string(),
	additionalDirectories: defaultOnError(vecSkipError(string()).optional(), () => []),
	mcpServers: requiredDefaultOnError(vecSkipError(zMcpServer), () => []),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Request parameters for loading an existing session.
*
* Only available if the Agent supports the `loadSession` capability.
*
* See protocol docs: [Loading Sessions](https://agentclientprotocol.com/protocol/session-setup#loading-sessions)
*/
const zLoadSessionRequest = object({
	mcpServers: requiredDefaultOnError(vecSkipError(zMcpServer), () => []),
	cwd: string(),
	additionalDirectories: defaultOnError(vecSkipError(string()).optional(), () => []),
	sessionId: zSessionId,
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Request parameters for listing existing sessions.
*
* Only available if the Agent supports the `sessionCapabilities.list` capability.
*/
const zListSessionsRequest = object({
	cwd: string().nullish(),
	cursor: string().nullish(),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Request parameters for deleting an existing session from `session/list`.
*
* Only available if the Agent supports the `sessionCapabilities.delete` capability.
*/
const zDeleteSessionRequest = object({
	sessionId: zSessionId,
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Request parameters for forking an existing session.
*
* Creates a new session based on the context of an existing one, allowing
* operations like generating summaries without affecting the original session's history.
*
* Only available if the Agent supports the `session.fork` capability.
*
* @experimental
*/
const zForkSessionRequest = object({
	sessionId: zSessionId,
	cwd: string(),
	additionalDirectories: defaultOnError(vecSkipError(string()).optional(), () => []),
	mcpServers: defaultOnError(vecSkipError(zMcpServer).optional(), () => []),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Request parameters for resuming an existing session.
*
* Resumes an existing session without returning previous messages (unlike `session/load`).
* This is useful for agents that can resume sessions but don't implement full session loading.
*
* Only available if the Agent supports the `sessionCapabilities.resume` capability.
*/
const zResumeSessionRequest = object({
	sessionId: zSessionId,
	cwd: string(),
	additionalDirectories: defaultOnError(vecSkipError(string()).optional(), () => []),
	mcpServers: defaultOnError(vecSkipError(zMcpServer).optional(), () => []),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Request parameters for closing an active session.
*
* If supported, the agent **must** cancel any ongoing work related to the session
* (treat it as if `session/cancel` was called) and then free up any resources
* associated with the session.
*
* Only available if the Agent supports the `sessionCapabilities.close` capability.
*/
const zCloseSessionRequest = object({
	sessionId: zSessionId,
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Request parameters for setting a session mode.
*/
const zSetSessionModeRequest = object({
	sessionId: zSessionId,
	modeId: zSessionModeId,
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Request parameters for setting a session configuration option.
*/
const zSetSessionConfigOptionRequest = intersection(union([object({
	value: boolean(),
	type: literal("boolean")
}), object({ value: zSessionConfigValueId })]), object({
	sessionId: zSessionId,
	configId: zSessionConfigId,
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
}));
/**
* Request parameters for sending a user prompt to the agent.
*
* Contains the user's message and any additional context.
*
* See protocol docs: [User Message](https://agentclientprotocol.com/protocol/prompt-turn#1-user-message)
*/
const zPromptRequest = object({
	sessionId: zSessionId,
	prompt: array(zContentBlock),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* A workspace folder.
*/
const zWorkspaceFolder = object({
	uri: string(),
	name: string(),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Repository metadata for an NES session.
*/
const zNesRepository = object({
	name: string(),
	owner: string(),
	remoteUrl: string(),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Request to start an NES session.
*/
const zStartNesRequest = object({
	workspaceUri: defaultOnError(string().nullish(), () => void 0),
	workspaceFolders: array(zWorkspaceFolder).nullish(),
	repository: defaultOnError(zNesRepository.nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* What triggered the suggestion request.
*/
const zNesTriggerKind = union([
	literal("automatic"),
	literal("diagnostic"),
	literal("manual")
]);
/**
* A recently accessed file.
*/
const zNesRecentFile = object({
	uri: string(),
	languageId: string(),
	text: string(),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* A code excerpt from a file.
*/
const zNesExcerpt = object({
	startLine: int().gte(0).max(4294967295, { error: "Invalid value: Expected uint32 to be <= 4294967295" }),
	endLine: int().gte(0).max(4294967295, { error: "Invalid value: Expected uint32 to be <= 4294967295" }),
	text: string(),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* A related code snippet from a file.
*/
const zNesRelatedSnippet = object({
	uri: string(),
	excerpts: array(zNesExcerpt),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* An entry in the edit history.
*/
const zNesEditHistoryEntry = object({
	uri: string(),
	diff: string(),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* A user action (typing, cursor movement, etc.).
*/
const zNesUserAction = object({
	action: string(),
	uri: string(),
	position: zPosition,
	timestampMs: number(),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* An open file in the editor.
*/
const zNesOpenFile = object({
	uri: string(),
	languageId: string(),
	visibleRange: defaultOnError(zRange.nullish(), () => void 0),
	lastFocusedMs: defaultOnError(number().nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Severity of a diagnostic.
*/
const zNesDiagnosticSeverity = union([
	literal("error"),
	literal("warning"),
	literal("information"),
	literal("hint")
]);
/**
* A diagnostic (error, warning, etc.).
*/
const zNesDiagnostic = object({
	uri: string(),
	range: zRange,
	severity: zNesDiagnosticSeverity,
	message: string(),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Context attached to a suggestion request.
*/
const zNesSuggestContext = object({
	recentFiles: array(zNesRecentFile).nullish(),
	relatedSnippets: array(zNesRelatedSnippet).nullish(),
	editHistory: array(zNesEditHistoryEntry).nullish(),
	userActions: array(zNesUserAction).nullish(),
	openFiles: array(zNesOpenFile).nullish(),
	diagnostics: array(zNesDiagnostic).nullish(),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Request for a code suggestion.
*/
const zSuggestNesRequest = object({
	sessionId: zSessionId,
	uri: string(),
	version: number(),
	position: zPosition,
	selection: zRange.nullish(),
	triggerKind: zNesTriggerKind,
	context: zNesSuggestContext.nullish(),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Request to close an NES session.
*
* The agent **must** cancel any ongoing work related to the NES session
* and then free up any resources associated with the session.
*/
const zCloseNesRequest = object({
	sessionId: zSessionId,
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
object({
	id: zRequestId,
	method: string(),
	params: union([
		zInitializeRequest,
		zAuthenticateRequest,
		zListProvidersRequest,
		zSetProviderRequest,
		zDisableProviderRequest,
		zLogoutRequest,
		zNewSessionRequest,
		zLoadSessionRequest,
		zListSessionsRequest,
		zDeleteSessionRequest,
		zForkSessionRequest,
		zResumeSessionRequest,
		zCloseSessionRequest,
		zSetSessionModeRequest,
		zSetSessionConfigOptionRequest,
		zPromptRequest,
		zStartNesRequest,
		zSuggestNesRequest,
		zCloseNesRequest,
		zMessageMcpRequest,
		zExtRequest
	]).nullish()
});
/**
* Response to `fs/write_text_file`
*/
const zWriteTextFileResponse = object({ _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0) });
/**
* Response containing the contents of a text file.
*/
const zReadTextFileResponse = object({
	content: string(),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* The user selected one of the provided options.
*/
const zSelectedPermissionOutcome = object({
	optionId: zPermissionOptionId,
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Response to a permission request.
*/
const zRequestPermissionResponse = object({
	outcome: union([object({ outcome: literal("cancelled") }), zSelectedPermissionOutcome.and(object({ outcome: literal("selected") }))]),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Response containing the ID of the created terminal.
*/
const zCreateTerminalResponse = object({
	terminalId: zTerminalId,
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Exit status of a terminal command.
*/
const zTerminalExitStatus = object({
	exitCode: defaultOnError(int().gte(0).max(4294967295, { error: "Invalid value: Expected uint32 to be <= 4294967295" }).nullish(), () => void 0),
	signal: defaultOnError(string().nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Response containing the terminal output and exit status.
*/
const zTerminalOutputResponse = object({
	output: string(),
	truncated: boolean(),
	exitStatus: defaultOnError(zTerminalExitStatus.nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Response to terminal/release method
*/
const zReleaseTerminalResponse = object({ _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0) });
/**
* Response containing the exit status of a terminal command.
*/
const zWaitForTerminalExitResponse = object({
	exitCode: defaultOnError(int().gte(0).max(4294967295, { error: "Invalid value: Expected uint32 to be <= 4294967295" }).nullish(), () => void 0),
	signal: defaultOnError(string().nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Response to `terminal/kill` method
*/
const zKillTerminalResponse = object({ _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0) });
/**
* Allowed wire representations for [`ElicitationContentValue`].
*/
const zElicitationContentValue = union([
	string(),
	number(),
	number(),
	boolean(),
	array(string())
]);
/**
* The user accepted the elicitation and provided content.
*/
const zElicitationAcceptAction = object({ content: record(string(), zElicitationContentValue).nullish() });
union([object({
	id: zRequestId,
	result: union([
		zWriteTextFileResponse,
		zReadTextFileResponse,
		zRequestPermissionResponse,
		zCreateTerminalResponse,
		zTerminalOutputResponse,
		zReleaseTerminalResponse,
		zWaitForTerminalExitResponse,
		zKillTerminalResponse,
		preserveCustomPayload(intersection(union([
			zElicitationAcceptAction.and(object({ action: literal("accept") })),
			object({ action: literal("decline") }),
			object({ action: literal("cancel") }),
			excludeKnownTags(object({ action: string() }), "action", [
				"accept",
				"cancel",
				"decline"
			])
		]), object({ _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0) })), "action", [
			"accept",
			"cancel",
			"decline"
		]),
		object({
			connectionId: zMcpConnectionId,
			_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
		}),
		object({ _meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0) }),
		zMessageMcpResponse,
		zExtResponse
	])
}), object({
	id: zRequestId,
	error: zError
})]);
/**
* Notification to cancel ongoing operations for a session.
*
* See protocol docs: [Cancellation](https://agentclientprotocol.com/protocol/prompt-turn#cancellation)
*/
const zCancelNotification = object({
	sessionId: zSessionId,
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Notification sent when a file is opened in the editor.
*/
const zDidOpenDocumentNotification = object({
	sessionId: zSessionId,
	uri: string(),
	languageId: string(),
	version: number(),
	text: string(),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* A content change event for a document.
*
* When `range` is `None`, `text` is the full content of the document.
* When `range` is `Some`, `text` replaces the given range.
*/
const zTextDocumentContentChangeEvent = object({
	range: zRange.nullish(),
	text: string(),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Notification sent when a file is edited.
*/
const zDidChangeDocumentNotification = object({
	sessionId: zSessionId,
	uri: string(),
	version: number(),
	contentChanges: requiredDefaultOnError(vecSkipError(zTextDocumentContentChangeEvent), () => []),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Notification sent when a file is closed.
*/
const zDidCloseDocumentNotification = object({
	sessionId: zSessionId,
	uri: string(),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Notification sent when a file is saved.
*/
const zDidSaveDocumentNotification = object({
	sessionId: zSessionId,
	uri: string(),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Notification sent when a file becomes the active editor tab.
*/
const zDidFocusDocumentNotification = object({
	sessionId: zSessionId,
	uri: string(),
	version: number(),
	position: zPosition,
	visibleRange: zRange,
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Notification sent when a suggestion is accepted.
*/
const zAcceptNesNotification = object({
	sessionId: zSessionId,
	id: zNesSuggestionId,
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
/**
* Notification sent when a suggestion is rejected.
*/
const zRejectNesNotification = object({
	sessionId: zSessionId,
	id: zNesSuggestionId,
	reason: defaultOnError(union([
		literal("rejected"),
		literal("ignored"),
		literal("replaced"),
		literal("cancelled")
	]).nullish(), () => void 0),
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
object({
	method: string(),
	params: union([
		zCancelNotification,
		zDidOpenDocumentNotification,
		zDidChangeDocumentNotification,
		zDidCloseDocumentNotification,
		zDidSaveDocumentNotification,
		zDidFocusDocumentNotification,
		zAcceptNesNotification,
		zRejectNesNotification,
		zMessageMcpNotification,
		zExtNotification
	]).nullish()
});
object({
	requestId: zRequestId,
	_meta: defaultOnError(record(string(), unknown()).nullish(), () => void 0)
});
//#endregion
//#region node_modules/@agentclientprotocol/sdk/dist/jsonrpc.js
const CANCEL_REQUEST_METHOD = "$/cancel_request";
function isRequestMessage(value) {
	return isJsonRpcEnvelope(value) && "id" in value && typeof value["method"] === "string" && isJsonRpcId(value["id"]);
}
function isResponseMessage(value) {
	if (!isJsonRpcEnvelope(value) || "method" in value) return false;
	if (!("id" in value) || !isJsonRpcId(value["id"])) return false;
	const hasResult = Object.hasOwn(value, "result");
	const hasError = Object.hasOwn(value, "error");
	if (hasResult === hasError) return false;
	return !hasError || isErrorResponse(value["error"]);
}
function isNotificationMessage(value) {
	return isJsonRpcEnvelope(value) && !("id" in value) && typeof value["method"] === "string";
}
function isRecord(value) {
	return typeof value === "object" && value !== null;
}
function isJsonRpcEnvelope(value) {
	return isRecord(value) && value["jsonrpc"] === "2.0";
}
function isJsonRpcId(value) {
	return value === null || typeof value === "string" || typeof value === "number" && Number.isFinite(value);
}
/**
* Detects response-shaped objects, including malformed responses, so they are
* never handled as calls that require a JSON-RPC response.
*
* @internal
*/
function isResponseShapedMessage(value) {
	return isRecord(value) && !("method" in value) && ("id" in value || "result" in value || "error" in value);
}
/**
* Classifies a potentially malformed batch using the direction established by
* its valid entries. A valid call takes precedence because response members in
* a call batch must be rejected. Otherwise, a valid response establishes
* response semantics so malformed siblings cannot provoke another response.
* Shape hints are used only when the batch has no valid messages; an `id` alone
* is ambiguous, and batches without a direction hint default to call semantics.
*
* @internal
*/
function isResponseBatch(batch) {
	let hasValidCall = false;
	let hasValidResponse = false;
	let hasCallShape = false;
	let hasResponseShape = false;
	for (const entry of batch) {
		hasValidCall ||= isRequestMessage(entry) || isNotificationMessage(entry);
		hasValidResponse ||= isResponseMessage(entry);
		if (!isRecord(entry)) continue;
		hasCallShape ||= "method" in entry;
		hasResponseShape ||= "result" in entry || "error" in entry;
	}
	if (hasValidCall) return false;
	if (hasValidResponse) return true;
	return hasResponseShape && !hasCallShape;
}
function cancelRequestId(params) {
	if (!isRecord(params) || !isJsonRpcId(params["requestId"])) return;
	return params["requestId"];
}
function isErrorResponse(value) {
	return isRecord(value) && typeof value["code"] === "number" && Number.isInteger(value["code"]) && typeof value["message"] === "string";
}
/**
* Helpers for constructing `HandleResult` values.
*/
const Handled = {
	/**
	* Marks a message as handled.
	*/
	yes() {
		return { handled: true };
	},
	/**
	* Leaves a message unhandled so later handlers can process it.
	*/
	no(message, retry = false) {
		return {
			handled: false,
			message,
			retry
		};
	}
};
function rejectedPromise(error) {
	const promise = Promise.reject(error);
	promise.catch(() => {});
	return promise;
}
function errorDetails(error) {
	if (error instanceof Error) return error.message;
	if (typeof error === "object" && error != null && "message" in error && typeof error.message === "string") return error.message;
}
function isZodError(error) {
	return typeof error === "object" && error !== null && "name" in error && error.name === "ZodError" && "issues" in error && Array.isArray(error.issues) && "format" in error && typeof error.format === "function";
}
function errorToResult(error) {
	if (error instanceof RequestError) return error.toResult();
	if (isZodError(error)) return RequestError.invalidParams(error.format()).toResult();
	const details = errorDetails(error);
	try {
		return RequestError.internalError(details ? JSON.parse(details) : {}).toResult();
	} catch {
		return RequestError.internalError({ details }).toResult();
	}
}
function requestCancelledError(reason) {
	if (reason instanceof RequestError && reason.code === -32800) return reason;
	return RequestError.requestCancelled(reason);
}
function errorToRequestResult(error, signal) {
	const requestCancelled = abortErrorToRequestCancelled(error, signal);
	return requestCancelled ? requestCancelled.toResult() : errorToResult(error);
}
function abortErrorToRequestCancelled(error, signal) {
	if (!signal.aborted || !isAbortError(error)) return;
	return requestCancelledError(signal.reason);
}
function isAbortError(error) {
	if (typeof error !== "object" || error === null) return false;
	const maybeAbortError = error;
	return maybeAbortError.name === "AbortError" || maybeAbortError.code === "ABORT_ERR";
}
/**
* Responder for one incoming JSON-RPC request.
*
* Handlers may use this when they need to decide exactly when or how the
* response is sent.
*/
var RequestResponder = class {
	id;
	sendResult;
	signal;
	finishRequest;
	didRespond = false;
	constructor(id, sendResult, signal = new AbortController().signal, finishRequest) {
		this.id = id;
		this.sendResult = sendResult;
		this.signal = signal;
		this.finishRequest = finishRequest;
	}
	/**
	* Whether this request has already received a response.
	*/
	get responded() {
		return this.didRespond;
	}
	/**
	* Sends a successful JSON-RPC response.
	*/
	respond(response) {
		return this.respondWithResult({ result: response ?? null });
	}
	/**
	* Sends an error JSON-RPC response.
	*/
	respondWithError(error) {
		const errorResponse = error instanceof RequestError ? error.toErrorResponse() : error;
		return this.respondWithResult({ error: errorResponse });
	}
	/**
	* Sends a complete JSON-RPC result payload.
	*/
	respondWithResult(result) {
		if (this.didRespond) return rejectedPromise(/* @__PURE__ */ new Error("JSON-RPC request already responded"));
		this.didRespond = true;
		return this.sendResult(result).finally(() => {
			this.finishRequest?.();
		});
	}
};
const requestBatchSizes = /* @__PURE__ */ new WeakMap();
/**
* Disposable handle returned when a handler is registered dynamically.
*/
var HandlerRegistration = class {
	disposeHandler;
	active = true;
	constructor(disposeHandler) {
		this.disposeHandler = disposeHandler;
	}
	/**
	* Unregisters the associated handler.
	*/
	dispose() {
		if (!this.active) return;
		this.active = false;
		this.disposeHandler();
	}
	/**
	* Supports explicit resource management with `using`.
	*/
	[Symbol.dispose]() {
		this.dispose();
	}
	/**
	* Returns this registration for call sites that intentionally keep it active.
	*/
	runIndefinitely() {
		return this;
	}
};
/**
* Per-connection context passed to low-level JSON-RPC handlers.
*/
var ConnectionContext = class {
	connection;
	constructor(connection) {
		this.connection = connection;
	}
	/**
	* Sends a request over the connection.
	*/
	sendRequest(method, params, mapResponse, options) {
		return this.connection.sendRequest(method, params, mapResponse, options);
	}
	/**
	* Sends a notification over the connection.
	*/
	sendNotification(method, params) {
		return this.connection.sendNotification(method, params);
	}
	/**
	* Sends a non-empty JSON-RPC batch in one transport message.
	*/
	sendBatch(entries) {
		return this.connection.sendBatch(entries);
	}
	/**
	* Sends a protocol-level request cancellation notification.
	*/
	sendCancelRequest(requestId) {
		return this.connection.sendCancelRequest(requestId);
	}
	/**
	* Registers a handler that can be disposed independently.
	*/
	addDynamicHandler(handler) {
		return this.connection.addDynamicHandler(handler);
	}
	/**
	* AbortSignal that aborts when the connection closes.
	*/
	get signal() {
		return this.connection.signal;
	}
	/**
	* Promise that resolves when the connection closes.
	*/
	get closed() {
		return this.connection.closed;
	}
};
/**
* Lower-level JSON-RPC connection over an ACP `Stream`.
*
* Most ACP integrations should use `agent(...)` or `client(...)`. Use this
* class when building generic JSON-RPC middleware or custom dispatch behavior.
*/
var Connection = class {
	pendingResponses = /* @__PURE__ */ new Map();
	incomingRequests = /* @__PURE__ */ new Map();
	nextRequestId = 0;
	staticHandlers = [];
	dynamicHandlers = /* @__PURE__ */ new Set();
	stream;
	writeQueue = Promise.resolve();
	abortController = new AbortController();
	closedPromise;
	retryQueue = [];
	context = new ConnectionContext(this);
	receiveReader;
	allowBatches = true;
	constructor(requestHandlerOrStream, notificationHandlerOrHandlers, streamOrOptions, options) {
		if (typeof requestHandlerOrStream === "function") {
			const requestHandler = requestHandlerOrStream;
			const notificationHandler = notificationHandlerOrHandlers;
			const stream = streamOrOptions;
			this.initialize(stream, [...options?.handlers ?? [], this.legacyHandler(requestHandler, notificationHandler)], options);
			return;
		}
		const stream = requestHandlerOrStream;
		const handlers = notificationHandlerOrHandlers;
		const connectionOptions = streamOrOptions;
		this.initialize(stream, [...connectionOptions?.handlers ?? [], ...handlers], connectionOptions);
	}
	/**
	* Creates a builder for configuring a handler-based connection.
	*/
	static builder() {
		return new ConnectionBuilder();
	}
	/**
	* Runs an operation while the connection is open, then closes the connection.
	*
	* If the stream closes before `op` settles, the returned promise rejects with
	* the connection close reason.
	*/
	runUntil(op) {
		let opSettled = false;
		const opPromise = Promise.resolve().then(() => op(this.context)).finally(() => {
			opSettled = true;
		});
		const closedPromise = this.closed.then(() => {
			if (opSettled) return new Promise(() => {});
			throw this.closedReason();
		});
		return Promise.race([opPromise, closedPromise]).finally(() => {
			opSettled = true;
			this.close();
		});
	}
	/**
	* Adds a handler after the connection has started.
	*
	* Any messages queued with `Handled.no(message, true)` are retried after the
	* handler is added.
	*/
	addDynamicHandler(handler) {
		this.dynamicHandlers.add(handler);
		if (this.retryQueue.length > 0) for (const message of this.retryQueue.splice(0)) this.processIncomingMessage(message).catch((error) => this.close(error));
		return new HandlerRegistration(() => {
			this.dynamicHandlers.delete(handler);
		});
	}
	/**
	* AbortSignal that aborts when the connection closes.
	*/
	get signal() {
		return this.abortController.signal;
	}
	/**
	* Promise that resolves when the connection closes.
	*/
	get closed() {
		return this.closedPromise;
	}
	/** @internal */
	getContext() {
		return this.context;
	}
	/**
	* Sends a JSON-RPC request.
	*
	* `mapResponse` can convert the raw result before the returned promise
	* resolves.
	*/
	sendRequest(method, params, mapResponse, options = {}) {
		if (this.abortController.signal.aborted) return rejectedPromise(this.closedReason());
		const request = this.prepareRequest(method, params, mapResponse, options);
		this.sendWireMessage(request.message).catch(() => {});
		if (options.cancellationSignal?.aborted) request.cancel();
		return request.response;
	}
	/**
	* Sends a non-empty JSON-RPC batch in one transport message.
	*
	* Requests and notifications are processed independently by the peer. The
	* returned tuple preserves the input order: request entries resolve to their
	* mapped response, while notification entries resolve to `undefined`.
	*/
	sendBatch(entries) {
		if (this.abortController.signal.aborted) return rejectedPromise(this.closedReason());
		if (!this.allowBatches) return rejectedPromise(/* @__PURE__ */ new TypeError("JSON-RPC batches are not supported on this connection"));
		if (entries.length === 0) return rejectedPromise(/* @__PURE__ */ new TypeError("JSON-RPC batch must contain at least one entry"));
		const messages = [];
		const cancellations = [];
		const outputs = [];
		for (const entry of entries) {
			if (entry.kind === "notification") {
				messages.push({
					jsonrpc: "2.0",
					method: entry.method,
					params: entry.params
				});
				outputs.push(Promise.resolve(void 0));
				continue;
			}
			const request = this.prepareRequest(entry.method, entry.params, entry.mapResponse, entry.options);
			messages.push(request.message);
			outputs.push(request.response);
			cancellations.push({
				signal: entry.options?.cancellationSignal,
				cancel: request.cancel
			});
		}
		const batch = messages;
		const batchSent = this.sendWireMessage(batch);
		for (const cancellation of cancellations) if (cancellation.signal?.aborted) cancellation.cancel();
		const response = Promise.all([batchSent, ...outputs]).then(([, ...resolved]) => resolved);
		response.catch(() => {});
		return response;
	}
	/**
	* Sends a protocol-level request cancellation notification.
	*/
	sendCancelRequest(requestId) {
		return this.sendNotification(CANCEL_REQUEST_METHOD, { requestId });
	}
	/**
	* Sends a JSON-RPC notification.
	*/
	sendNotification(method, params) {
		if (this.abortController.signal.aborted) return rejectedPromise(this.closedReason());
		return this.sendWireMessage({
			jsonrpc: "2.0",
			method,
			params
		});
	}
	prepareRequest(method, params, mapResponse, options = {}) {
		const id = this.nextRequestId++;
		let cancel = () => {};
		const response = new Promise((resolve, reject) => {
			const pendingResponse = {
				resolve: (value) => {
					try {
						resolve(mapResponse ? mapResponse(value) : value);
					} catch (error) {
						reject(error);
					}
				},
				reject
			};
			cancel = () => {
				if (pendingResponse.cancellationSent) return;
				pendingResponse.cancellationSent = true;
				pendingResponse.cleanup?.();
				this.sendCancelRequest(id).catch(() => {});
			};
			options.cancellationSignal?.addEventListener("abort", cancel, { once: true });
			pendingResponse.cleanup = () => {
				options.cancellationSignal?.removeEventListener("abort", cancel);
			};
			this.pendingResponses.set(id, pendingResponse);
		});
		response.catch(() => {});
		return {
			message: {
				jsonrpc: "2.0",
				id,
				method,
				params
			},
			response,
			cancel: () => cancel()
		};
	}
	/**
	* Closes the connection and rejects pending requests.
	*/
	close(error) {
		if (this.abortController.signal.aborted) return;
		const closeError = error ?? /* @__PURE__ */ new Error("ACP connection closed");
		this.abortController.abort(closeError);
		for (const pendingResponse of this.pendingResponses.values()) {
			pendingResponse.cleanup?.();
			pendingResponse.reject(closeError);
		}
		this.pendingResponses.clear();
		for (const controller of this.incomingRequests.values()) controller.abort(closeError);
		this.incomingRequests.clear();
		this.receiveReader?.cancel(closeError).catch(() => {});
	}
	initialize(stream, handlers, options) {
		this.stream = stream;
		this.staticHandlers = handlers;
		this.allowBatches = options?.allowBatches ?? true;
		this.closedPromise = new Promise((resolve) => {
			this.abortController.signal.addEventListener("abort", () => resolve());
		});
		this.receive();
	}
	legacyHandler(requestHandler, notificationHandler) {
		return { handleMessage: async (message, cx) => {
			if (message.kind === "request") {
				const result = await requestHandler(message.method, message.params, cx);
				await message.responder.respond(result);
			} else await notificationHandler(message.method, message.params, cx);
			return Handled.yes();
		} };
	}
	async receive() {
		let closeError = void 0;
		try {
			const reader = this.stream.readable.getReader();
			this.receiveReader = reader;
			try {
				while (!this.abortController.signal.aborted) {
					const { value: message, done } = await reader.read();
					if (this.abortController.signal.aborted) break;
					if (done) break;
					this.receiveWireMessage(message);
				}
			} finally {
				if (this.receiveReader === reader) this.receiveReader = void 0;
				reader.releaseLock();
			}
		} catch (error) {
			closeError = error;
		} finally {
			this.close(closeError);
		}
	}
	receiveWireMessage(message) {
		if (Array.isArray(message)) {
			if (!this.allowBatches) {
				this.close(/* @__PURE__ */ new TypeError("JSON-RPC batches are not supported on this connection"));
				return;
			}
			this.receiveBatch(message);
			return;
		}
		if (!isRequestMessage(message) && !isNotificationMessage(message) && !isResponseShapedMessage(message)) {
			this.sendWireMessage(protocolErrorResponse(RequestError.invalidRequest(message))).catch(() => {});
			return;
		}
		this.receiveMessage(message);
	}
	receiveBatch(batch) {
		if (batch.length === 0) {
			this.sendWireMessage(protocolErrorResponse(RequestError.invalidRequest(batch))).catch(() => {});
			return;
		}
		const responseBatch = isResponseBatch(batch);
		let remaining = responseBatch ? 0 : batch.reduce((count, message) => count + (isNotificationMessage(message) ? 0 : 1), 0);
		let remainingNotifications = batch.reduce((count, message) => count + (isNotificationMessage(message) ? 1 : 0), 0);
		let responseSent = false;
		const responses = [];
		const sendResponsesIfReady = async () => {
			if (responseSent || remaining !== 0 || remainingNotifications !== 0 || responses.length === 0) return;
			responseSent = true;
			await this.sendWireMessage(responses);
		};
		const collectResponse = async (response) => {
			responses.push(response);
			remaining -= 1;
			await sendResponsesIfReady();
		};
		for (const message of batch) {
			if (responseBatch) {
				if (isResponseShapedMessage(message)) this.receiveMessage(message);
				continue;
			}
			if (!isRequestMessage(message) && !isNotificationMessage(message)) {
				collectResponse(protocolErrorResponse(RequestError.invalidRequest(message))).catch(() => {});
				continue;
			}
			const processing = this.receiveMessage(message, isRequestMessage(message) ? collectResponse : void 0, batch.length);
			if (isNotificationMessage(message)) processing.finally(() => {
				remainingNotifications -= 1;
				sendResponsesIfReady().catch((error) => this.close(error));
			});
		}
	}
	receiveMessage(message, sendResponse, batchSize) {
		if (this.abortController.signal.aborted) return Promise.resolve();
		if (!isRecord(message)) {
			console.error("Invalid message", { message });
			return Promise.resolve();
		}
		if ("method" in message) {
			if (!("id" in message)) this.handleProtocolNotification(message);
			return this.processIncomingMessage(this.toIncomingMessage(message, sendResponse, batchSize)).catch((error) => this.close(error));
		} else if ("id" in message) this.handleResponse(message);
		else console.error("Invalid message", { message });
		return Promise.resolve();
	}
	async processIncomingMessage(message) {
		if (this.abortController.signal.aborted) return;
		let current = message;
		let retry = false;
		try {
			for (const handler of [...this.staticHandlers, ...this.dynamicHandlers.values()]) {
				if (this.abortController.signal.aborted) return;
				const result = await handler.handleMessage(current, this.context) ?? { handled: true };
				if (result.handled) return;
				current = result.message ?? current;
				retry = retry || Boolean(result.retry);
			}
			if (retry) this.retryQueue.push(current);
			else if (current.kind === "request") await current.responder.respondWithError(RequestError.methodNotFound(current.method));
		} catch (error) {
			if (this.abortController.signal.aborted) return;
			if (current.kind === "request" && !current.responder.responded) await current.responder.respondWithResult(errorToRequestResult(error, current.responder.signal));
			else {
				const response = errorToResult(error);
				if ("error" in response) console.error("Error handling notification", message.raw, response.error);
			}
		}
	}
	toIncomingMessage(message, sendResponse, batchSize) {
		if ("id" in message) {
			const abortController = new AbortController();
			this.incomingRequests.set(message.id, abortController);
			const finishRequest = () => {
				if (this.incomingRequests.get(message.id) === abortController) this.incomingRequests.delete(message.id);
			};
			const responder = new RequestResponder(message.id, (result) => {
				const response = {
					jsonrpc: "2.0",
					id: message.id,
					...result
				};
				return sendResponse ? sendResponse(response) : this.sendWireMessage(response);
			}, abortController.signal, finishRequest);
			if (batchSize !== void 0) requestBatchSizes.set(responder, batchSize);
			return {
				kind: "request",
				method: message.method,
				params: message.params,
				raw: message,
				signal: abortController.signal,
				responder
			};
		}
		return {
			kind: "notification",
			method: message.method,
			params: message.params,
			raw: message
		};
	}
	handleResponse(response) {
		const pendingResponse = this.pendingResponses.get(response.id);
		if (pendingResponse) {
			this.pendingResponses.delete(response.id);
			pendingResponse.cleanup?.();
			if (!isResponseMessage(response)) pendingResponse.reject(RequestError.invalidRequest(response));
			else if ("result" in response) pendingResponse.resolve(response.result);
			else {
				const { code, message, data } = response.error;
				pendingResponse.reject(new RequestError(code, message, data));
			}
		} else console.error("Got response to unknown request", response.id);
	}
	handleProtocolNotification(message) {
		if (message.method !== CANCEL_REQUEST_METHOD) return;
		const requestId = cancelRequestId(message.params);
		if (requestId === void 0) return;
		const controller = this.incomingRequests.get(requestId);
		if (!controller || controller.signal.aborted) return;
		controller.abort(RequestError.requestCancelled({ requestId }));
	}
	closedReason() {
		return this.abortController.signal.reason ?? /* @__PURE__ */ new Error("ACP connection closed");
	}
	async sendWireMessage(message) {
		if (this.abortController.signal.aborted) return rejectedPromise(this.closedReason());
		this.writeQueue = this.writeQueue.then(async () => {
			if (this.abortController.signal.aborted) throw this.closedReason();
			const writer = this.stream.writable.getWriter();
			try {
				await writer.write(message);
			} finally {
				writer.releaseLock();
			}
		}).catch((error) => {
			this.close(error);
			throw error;
		});
		return this.writeQueue;
	}
};
/**
* Builder for a lower-level handler-based JSON-RPC connection.
*/
var ConnectionBuilder = class {
	handlers = [];
	connectionName;
	/**
	* Sets a diagnostic name used by handlers created from this builder.
	*/
	name(name) {
		this.connectionName = name;
		return this;
	}
	/**
	* Adds a raw JSON-RPC handler to the handler chain.
	*/
	withHandler(handler) {
		this.handlers.push(handler);
		return this;
	}
	/**
	* Adds a handler that can inspect every incoming request or notification.
	*
	* Observer callbacks that return void pass the message through to later
	* handlers. Return `Handled.yes()` to stop dispatch explicitly.
	*/
	onReceiveMessage(handler) {
		return this.withHandler({
			handleMessage: async (message, cx) => await handler(message, cx) ?? Handled.no(message),
			describe: () => this.connectionName ?? "onReceiveMessage"
		});
	}
	/**
	* Adds a typed request handler for one method.
	*/
	onReceiveRequest(method, parse, handler) {
		return this.withHandler({
			handleMessage: async (message, cx) => {
				if (message.kind !== "request" || message.method !== method) return Handled.no(message);
				return await handler(parse(message.params), message.responder, cx) ?? Handled.yes();
			},
			describe: () => `${this.connectionName ?? "request"}:${method}`
		});
	}
	/**
	* Adds a typed notification handler for one method.
	*/
	onReceiveNotification(method, parse, handler) {
		return this.withHandler({
			handleMessage: async (message, cx) => {
				if (message.kind !== "notification" || message.method !== method) return Handled.no(message);
				return await handler(parse(message.params), cx) ?? Handled.yes();
			},
			describe: () => `${this.connectionName ?? "notification"}:${method}`
		});
	}
	/**
	* Connects the configured handlers to a stream.
	*/
	connect(stream, options) {
		return new Connection(stream, this.handlers, options);
	}
	/**
	* Connects to a stream for the lifetime of `op`, then closes the connection.
	*/
	connectWith(stream, op, options) {
		return this.connect(stream, options).runUntil(op);
	}
};
/**
* JSON-RPC error object.
*
* Represents an error that occurred during method execution, following the
* JSON-RPC 2.0 error object specification with optional additional data.
*
* See protocol docs: [JSON-RPC Error Object](https://www.jsonrpc.org/specification#error_object)
*/
var RequestError = class RequestError extends Error {
	code;
	/**
	* Additional JSON-RPC error data.
	*/
	data;
	constructor(code, message, data) {
		super(message);
		this.code = code;
		this.name = "RequestError";
		this.data = data;
	}
	/**
	* Invalid JSON was received by the server. An error occurred on the server while parsing the JSON text.
	*/
	static parseError(data, additionalMessage) {
		return new RequestError(-32700, `Parse error${additionalMessage ? `: ${additionalMessage}` : ""}`, data);
	}
	/**
	* The JSON sent is not a valid Request object.
	*/
	static invalidRequest(data, additionalMessage) {
		return new RequestError(-32600, `Invalid request${additionalMessage ? `: ${additionalMessage}` : ""}`, data);
	}
	/**
	* The method does not exist / is not available.
	*/
	static methodNotFound(method) {
		return new RequestError(-32601, `"Method not found": ${method}`, { method });
	}
	/**
	* Invalid method parameter(s).
	*/
	static invalidParams(data, additionalMessage) {
		return new RequestError(-32602, `Invalid params${additionalMessage ? `: ${additionalMessage}` : ""}`, data);
	}
	/**
	* Internal JSON-RPC error.
	*/
	static internalError(data, additionalMessage) {
		return new RequestError(-32603, `Internal error${additionalMessage ? `: ${additionalMessage}` : ""}`, data);
	}
	/**
	* Execution of the request was aborted.
	*/
	static requestCancelled(data, additionalMessage) {
		return new RequestError(-32800, `Request cancelled${additionalMessage ? `: ${additionalMessage}` : ""}`, data);
	}
	/**
	* Authentication required.
	*/
	static authRequired(data, additionalMessage) {
		return new RequestError(-32e3, `Authentication required${additionalMessage ? `: ${additionalMessage}` : ""}`, data);
	}
	/**
	* Resource, such as a file, was not found
	*/
	static resourceNotFound(uri) {
		return new RequestError(-32002, `Resource not found${uri ? `: ${uri}` : ""}`, uri && { uri });
	}
	/**
	* Converts this error to a JSON-RPC result object.
	*/
	toResult() {
		return { error: {
			code: this.code,
			message: this.message,
			data: this.data
		} };
	}
	/**
	* Converts this error to a JSON-RPC error response payload.
	*/
	toErrorResponse() {
		return {
			code: this.code,
			message: this.message,
			data: this.data
		};
	}
};
/**
* Creates a JSON-RPC error response for a request whose ID cannot be known.
*
* @internal
*/
function protocolErrorResponse(error) {
	return {
		jsonrpc: "2.0",
		id: null,
		error: error.toErrorResponse()
	};
}
//#endregion
//#region node_modules/@agentclientprotocol/sdk/dist/line-buffer.js
const newline = 10;
/**
* Incrementally splits a byte stream into newline-terminated lines.
*
* Only the newly pushed chunk is scanned for newlines, so splitting costs
* O(total bytes) no matter how many chunks a line spans.
*
* Chunks passed to {@link push} must not be mutated afterwards; a chunk
* without a newline is retained until its line completes.
*/
var LineBuffer = class {
	/** Bytes of the current (incomplete) line, carried across chunks. */
	#pending = [];
	/**
	* Consumes a chunk, returning each complete line without its trailing
	* newline.
	*/
	push(chunk) {
		const lines = [];
		let start = 0;
		let newlineIndex = chunk.indexOf(newline, start);
		while (newlineIndex !== -1) {
			lines.push(this.#takeLine(chunk.subarray(start, newlineIndex)));
			start = newlineIndex + 1;
			newlineIndex = chunk.indexOf(newline, start);
		}
		if (start < chunk.byteLength) this.#pending.push(start === 0 ? chunk : new Uint8Array(chunk.subarray(start)));
		return lines;
	}
	/**
	* Returns the trailing unterminated line and resets the buffer, or
	* undefined if no bytes are buffered.
	*/
	flush() {
		if (this.#pending.length === 0) return;
		return this.#takeLine(new Uint8Array(0));
	}
	#takeLine(tail) {
		if (this.#pending.length === 0) return tail;
		let total = tail.byteLength;
		for (const part of this.#pending) total += part.byteLength;
		const line = new Uint8Array(total);
		let offset = 0;
		for (const part of this.#pending) {
			line.set(part, offset);
			offset += part.byteLength;
		}
		line.set(tail, offset);
		this.#pending = [];
		return line;
	}
};
//#endregion
//#region node_modules/@agentclientprotocol/sdk/dist/stream.js
/**
* Creates an ACP Stream from a pair of newline-delimited JSON streams.
*
* This is the typical way to handle ACP connections over stdio, converting
* between AnyMessage objects and newline-delimited JSON.
*
* @param output - The writable stream to send encoded messages to
* @param input - The readable stream to receive encoded messages from
* @returns A Stream for bidirectional ACP communication
*/
function ndJsonStream$1(output, input) {
	const textEncoder = new TextEncoder();
	const textDecoder = new TextDecoder();
	let cancelled = false;
	let inputReader;
	let outputWrite = Promise.resolve();
	const writeJson = (message) => {
		const content = JSON.stringify(message) + "\n";
		const write = outputWrite.then(async () => {
			const writer = output.getWriter();
			try {
				await writer.write(textEncoder.encode(content));
			} finally {
				writer.releaseLock();
			}
		});
		outputWrite = write.catch(() => {});
		return write;
	};
	return {
		readable: new ReadableStream({
			async start(controller) {
				const lines = new LineBuffer();
				const enqueueLine = async (lineBytes) => {
					const trimmedLine = textDecoder.decode(lineBytes).trim();
					if (!trimmedLine) return;
					let message;
					try {
						message = JSON.parse(trimmedLine);
					} catch {
						await writeJson(protocolErrorResponse(RequestError.parseError()));
						return;
					}
					if (isRecord(message) || Array.isArray(message)) controller.enqueue(message);
					else await writeJson(protocolErrorResponse(RequestError.invalidRequest(message)));
				};
				const reader = input.getReader();
				inputReader = reader;
				try {
					while (true) {
						const { value, done } = await reader.read();
						if (cancelled) return;
						if (done) break;
						if (!value) continue;
						for (const line of lines.push(value)) {
							await enqueueLine(line);
							if (cancelled) return;
						}
					}
					if (cancelled) return;
					const lastLine = lines.flush();
					if (lastLine) await enqueueLine(lastLine);
				} catch (err) {
					if (cancelled) return;
					controller.error(err);
					return;
				} finally {
					if (inputReader === reader) inputReader = void 0;
					reader.releaseLock();
				}
				if (cancelled) return;
				controller.close();
			},
			cancel(reason) {
				cancelled = true;
				return inputReader?.cancel(reason);
			}
		}),
		writable: new WritableStream({ write(message) {
			return writeJson(message);
		} })
	};
}
zElicitationFormMode.and(object({ mode: literal("form") })).and(object({ message: string() }));
zElicitationUrlMode.and(object({ mode: literal("url") })).and(object({ message: string() }));
union([zElicitationSessionScope, zElicitationRequestScope]).and(object({ message: string() }));
zStringPropertySchema.and(object({ type: literal("string") }));
zNumberPropertySchema.and(object({ type: literal("number") }));
zIntegerPropertySchema.and(object({ type: literal("integer") }));
zBooleanPropertySchema.and(object({ type: literal("boolean") }));
zMultiSelectPropertySchema.and(object({ type: literal("array") }));
zStringMultiSelectItems.and(object({ type: literal("string") }));
zElicitationAcceptAction.and(object({ action: literal("accept") }));
object({ action: literal("decline") });
object({ action: literal("cancel") });
//#endregion
//#region node_modules/@agentclientprotocol/sdk/dist/acp.js
/**
* Creates a stable ACP v1 stream from newline-delimited JSON streams.
*
* @param output - The writable stream to send encoded messages to
* @param input - The readable stream to receive encoded messages from
* @returns A stream for bidirectional ACP v1 communication
*/
function ndJsonStream(output, input) {
	return ndJsonStream$1(output, input);
}
function emptyObjectResponse(response) {
	return response ?? {};
}
function isStream(value) {
	return typeof value === "object" && value !== null && "readable" in value && "writable" in value;
}
function memoryStreamPair() {
	const leftToRight = new TransformStream();
	const rightToLeft = new TransformStream();
	return [{
		readable: rightToLeft.readable,
		writable: leftToRight.writable
	}, {
		readable: leftToRight.readable,
		writable: rightToLeft.writable
	}];
}
/**
* ACP method-name constants.
*
* Use these with `onRequest(...)`, `onNotification(...)`, `request(...)`, and
* `notify(...)` when you want literal-string type inference without spelling
* protocol strings inline.
*/
const methods = {
	agent: {
		initialize: AGENT_METHODS.initialize,
		authenticate: AGENT_METHODS.authenticate,
		logout: AGENT_METHODS.logout,
		providers: {
			list: AGENT_METHODS.providers_list,
			set: AGENT_METHODS.providers_set,
			disable: AGENT_METHODS.providers_disable
		},
		session: {
			new: AGENT_METHODS.session_new,
			load: AGENT_METHODS.session_load,
			list: AGENT_METHODS.session_list,
			delete: AGENT_METHODS.session_delete,
			fork: AGENT_METHODS.session_fork,
			resume: AGENT_METHODS.session_resume,
			close: AGENT_METHODS.session_close,
			setMode: AGENT_METHODS.session_set_mode,
			setConfigOption: AGENT_METHODS.session_set_config_option,
			prompt: AGENT_METHODS.session_prompt,
			cancel: AGENT_METHODS.session_cancel
		},
		nes: {
			start: AGENT_METHODS.nes_start,
			suggest: AGENT_METHODS.nes_suggest,
			accept: AGENT_METHODS.nes_accept,
			reject: AGENT_METHODS.nes_reject,
			close: AGENT_METHODS.nes_close
		},
		document: {
			didOpen: AGENT_METHODS.document_did_open,
			didChange: AGENT_METHODS.document_did_change,
			didClose: AGENT_METHODS.document_did_close,
			didSave: AGENT_METHODS.document_did_save,
			didFocus: AGENT_METHODS.document_did_focus
		}
	},
	client: {
		session: {
			requestPermission: CLIENT_METHODS.session_request_permission,
			update: CLIENT_METHODS.session_update
		},
		fs: {
			writeTextFile: CLIENT_METHODS.fs_write_text_file,
			readTextFile: CLIENT_METHODS.fs_read_text_file
		},
		terminal: {
			create: CLIENT_METHODS.terminal_create,
			output: CLIENT_METHODS.terminal_output,
			release: CLIENT_METHODS.terminal_release,
			waitForExit: CLIENT_METHODS.terminal_wait_for_exit,
			kill: CLIENT_METHODS.terminal_kill
		},
		elicitation: {
			create: CLIENT_METHODS.elicitation_create,
			complete: CLIENT_METHODS.elicitation_complete
		}
	},
	protocol: { cancelRequest: PROTOCOL_METHODS.cancel_request }
};
const startActiveSession = Symbol("startActiveSession");
var AcpContext = class {
	cx;
	currentRequestId;
	/** @internal */
	constructor(cx, currentRequestId) {
		this.cx = cx;
		this.currentRequestId = currentRequestId;
	}
	/**
	* JSON-RPC id of the request currently being handled.
	*
	* This is `undefined` for notification handlers and for contexts created
	* outside an inbound request, such as `connect(...)` and `connectWith(...)`.
	*/
	get requestId() {
		return this.currentRequestId;
	}
	/** @internal */
	get connectionContext() {
		return this.cx;
	}
	/** @internal */
	sendRequest(method, params, mapResponse, options) {
		return this.cx.sendRequest(method, params, mapResponse, options);
	}
	/** @internal */
	sendNotification(method, params) {
		return this.cx.sendNotification(method, params);
	}
	/** @internal */
	addDynamicHandler(handler) {
		return this.cx.addDynamicHandler(handler);
	}
};
/**
* Context passed to agent-side handlers.
*
* Agents use this context to call client-side ACP methods while handling
* requests such as `session/prompt`.
*/
var AgentContext = class AgentContext extends AcpContext {
	constructor(cx, requestId) {
		super(cx, requestId);
	}
	/** @internal */
	static create(cx, requestId) {
		return new AgentContext(cx, requestId);
	}
	request(method, params, options) {
		const spec = clientRequestSpecsByMethod[method];
		return this.sendRequest(method, params, spec?.mapResponse, options);
	}
	notify(method, params) {
		return this.sendNotification(method, params);
	}
};
/**
* Context used by clients to call agent-side ACP methods.
*
* `connectWith` passes a `ClientContext` to the callback. Client handlers also
* receive one as `ctx.agent` when they need to call back into the agent.
*/
var ClientContext = class ClientContext extends AcpContext {
	constructor(cx, requestId) {
		super(cx, requestId);
	}
	/** @internal */
	static create(cx, requestId) {
		return new ClientContext(cx, requestId);
	}
	/** @internal */
	[startActiveSession](params, options) {
		return this.sendRequest(AGENT_METHODS.session_new, params, (response) => this.attachSession(response), options);
	}
	buildSession(cwdOrRequest) {
		if (typeof cwdOrRequest === "string") return SessionBuilder.create(this, {
			cwd: cwdOrRequest,
			mcpServers: []
		});
		return SessionBuilder.create(this, cwdOrRequest);
	}
	/**
	* Builds active-session helpers around a `session/new` response.
	*/
	attachSession(response) {
		const updates = new AsyncQueue();
		const closeSignal = this.connectionContext.signal;
		const failUpdatesOnClose = () => {
			updates.fail(closeSignal.reason ?? /* @__PURE__ */ new Error("ACP connection closed"));
		};
		if (closeSignal.aborted) failUpdatesOnClose();
		else closeSignal.addEventListener("abort", failUpdatesOnClose);
		const sessionRegistration = sessionUpdateRouter(this.connectionContext).attach(response, updates);
		const closeRegistration = new HandlerRegistration(() => {
			closeSignal.removeEventListener("abort", failUpdatesOnClose);
		});
		return ActiveSession.create(this, response, updates, [sessionRegistration, closeRegistration]);
	}
	request(method, params, options) {
		const spec = agentRequestSpecsByMethod[method];
		return this.sendRequest(method, params, spec?.mapResponse, options);
	}
	notify(method, params) {
		return this.sendNotification(method, params);
	}
};
var AcpConnectionHandle = class {
	connection;
	constructor(connection) {
		this.connection = connection;
	}
	get signal() {
		return this.connection.signal;
	}
	get closed() {
		return this.connection.closed;
	}
	close(error) {
		this.connection.close(error);
	}
};
var AgentConnectionHandle = class extends AcpConnectionHandle {
	connectHandlers;
	client;
	didStartConnectHandlers = false;
	constructor(connection, connectHandlers = []) {
		super(connection);
		this.connectHandlers = connectHandlers;
		this.client = AgentContext.create(connection.getContext());
	}
	/** @internal */
	startConnectHandlers() {
		if (this.didStartConnectHandlers) return;
		this.didStartConnectHandlers = true;
		runConnectHandlers(this, this.connectHandlers);
	}
};
var ClientConnectionHandle = class extends AcpConnectionHandle {
	connectHandlers;
	agent;
	didStartConnectHandlers = false;
	constructor(connection, connectHandlers = []) {
		super(connection);
		this.connectHandlers = connectHandlers;
		this.agent = ClientContext.create(connection.getContext());
	}
	/** @internal */
	startConnectHandlers() {
		if (this.didStartConnectHandlers) return;
		this.didStartConnectHandlers = true;
		runConnectHandlers(this, this.connectHandlers);
	}
};
function agentConnection(connection, connectHandlers = []) {
	return new AgentConnectionHandle(connection, connectHandlers);
}
function clientConnection(connection, connectHandlers = []) {
	return new ClientConnectionHandle(connection, connectHandlers);
}
var AsyncQueue = class {
	values = [];
	waiters = [];
	failed = false;
	failure;
	enqueue(value) {
		if (this.failed) return;
		const waiter = this.waiters.shift();
		if (waiter) waiter.resolve(value);
		else this.values.push({
			kind: "value",
			value
		});
	}
	reject(error) {
		if (this.failed) return;
		if (this.waiters.length > 0) {
			for (const waiter of this.waiters.splice(0)) waiter.reject(error);
			return;
		}
		this.values.push({
			kind: "error",
			error
		});
	}
	clearErrors() {
		this.values = this.values.filter((entry) => entry.kind === "value");
	}
	fail(error) {
		if (this.failed) return;
		this.failed = true;
		this.failure = error;
		for (const waiter of this.waiters.splice(0)) waiter.reject(error);
	}
	next() {
		if (this.values.length > 0) {
			const entry = this.values.shift();
			if (entry.kind === "error") return Promise.reject(entry.error);
			return Promise.resolve(entry.value);
		}
		if (this.failed) return Promise.reject(this.failure);
		return new Promise((resolve, reject) => {
			this.waiters.push({
				resolve,
				reject
			});
		});
	}
};
function cloneNewSessionRequest(request) {
	return {
		...request,
		additionalDirectories: request.additionalDirectories ? [...request.additionalDirectories] : void 0,
		mcpServers: [...request.mcpServers]
	};
}
/**
* Builder for creating an `ActiveSession`.
*
* Start from `ctx.buildSession("/absolute/cwd")` for the common case, or
* pass a full `NewSessionRequest` to `ctx.buildSession(...)` when the session
* needs MCP servers, `_meta`, or additional request fields. All paths in ACP
* payloads should be absolute.
*/
var SessionBuilder = class SessionBuilder {
	cx;
	request;
	constructor(cx, request) {
		this.cx = cx;
		this.request = cloneNewSessionRequest(request);
	}
	/** @internal */
	static create(cx, request) {
		return new SessionBuilder(cx, request);
	}
	/**
	* Returns the `session/new` request that will be sent.
	*
	* The returned object is a defensive copy, so mutating it does not change the
	* builder.
	*/
	toRequest() {
		return cloneNewSessionRequest(this.request);
	}
	/**
	* Replaces the additional workspace roots for this session.
	*
	* `additionalDirectories` expand the session's file-system scope without
	* changing `cwd`. Each path should be absolute.
	*/
	withAdditionalDirectories(additionalDirectories) {
		this.request = {
			...this.request,
			additionalDirectories: [...additionalDirectories]
		};
		return this;
	}
	/**
	* Adds one MCP server to the `session/new` request.
	*/
	withMcpServer(mcpServer) {
		this.request = {
			...this.request,
			mcpServers: [...this.request.mcpServers, mcpServer]
		};
		return this;
	}
	/**
	* Starts the session and returns an `ActiveSession` for prompting and reading
	* updates.
	*
	* Call `dispose()` on the returned session when you no longer need update
	* routing, or use `withSession(...)` to scope disposal automatically.
	*/
	async start(options) {
		return this.cx[startActiveSession](this.toRequest(), options);
	}
	/**
	* Starts the session, runs `op`, and disposes the active-session update
	* routing when `op` finishes or throws.
	*/
	async withSession(op) {
		const session = await this.start();
		try {
			return await op(session);
		} finally {
			session.dispose();
		}
	}
};
/**
* Convenience wrapper for an active ACP session.
*
* An active session routes `session/update` notifications for one session ID
* into an async queue. Use `prompt(...)` to send user content, then read updates
* with `nextUpdate()` until a `stop` message is returned.
*/
var ActiveSession = class ActiveSession {
	cx;
	sessionResponse;
	updates;
	registrations;
	constructor(cx, sessionResponse, updates, registrations) {
		this.cx = cx;
		this.sessionResponse = sessionResponse;
		this.updates = updates;
		this.registrations = registrations;
	}
	/** @internal */
	static create(cx, sessionResponse, updates, registrations) {
		return new ActiveSession(cx, sessionResponse, updates, registrations);
	}
	/**
	* Session ID returned by `session/new`.
	*/
	get sessionId() {
		return this.sessionResponse.sessionId;
	}
	/**
	* Mode state returned when the session was created, if the agent provided it.
	*/
	get modes() {
		return this.sessionResponse.modes;
	}
	/**
	* Metadata returned when the session was created.
	*/
	get meta() {
		return this.sessionResponse._meta;
	}
	/**
	* Full response returned by `session/new`.
	*/
	get newSessionResponse() {
		return this.sessionResponse;
	}
	/**
	* Sends a prompt to this session.
	*
	* Strings are converted to one text content block. A single content block is
	* wrapped in an array. The returned promise resolves with the final
	* `PromptResponse`, and the same completion is also queued as a `stop`
	* message for `nextUpdate()`.
	*/
	prompt(prompt, options) {
		this.updates.clearErrors();
		const response = this.cx.request(AGENT_METHODS.session_prompt, {
			sessionId: this.sessionId,
			prompt: this.promptBlocks(prompt)
		}, options);
		response.then((value) => {
			this.updates.enqueue({
				kind: "stop",
				response: value,
				stopReason: value.stopReason
			});
		}, (error) => {
			this.updates.reject(error);
		});
		return response;
	}
	/**
	* Reads the next update or stop message for this session.
	*/
	nextUpdate() {
		return this.updates.next();
	}
	/**
	* Reads text chunks until the current prompt turn stops.
	*
	* Only `agent_message_chunk` updates with text content are appended. Other
	* update types are ignored by this helper; use `nextUpdate()` when you need
	* tool calls, plans, or the final `PromptResponse`.
	*/
	async readText() {
		let output = "";
		for (;;) {
			const message = await this.nextUpdate();
			if (message.kind === "stop") return output;
			const { update } = message;
			if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") output += update.content.text;
		}
	}
	/**
	* Stops routing updates to this active-session helper.
	*
	* This does not close the ACP session on the agent. Use `ClientContext`
	* session lifecycle methods when the protocol session itself should be closed
	* or deleted.
	*/
	dispose() {
		for (const registration of this.registrations.splice(0)) registration.dispose();
		this.updates.fail(/* @__PURE__ */ new Error("Active session disposed"));
	}
	/**
	* Supports explicit resource management with `using`.
	*/
	[Symbol.dispose]() {
		this.dispose();
	}
	promptBlocks(prompt) {
		if (typeof prompt === "string") return [{
			type: "text",
			text: prompt
		}];
		if (Array.isArray(prompt)) return prompt;
		return [prompt];
	}
};
function parseParams(parser, params) {
	if (!parser) return params;
	if (typeof parser === "function") return parser(params);
	return parser.parse(params);
}
function requestSpec(method, params, mapResponse) {
	return {
		method,
		params,
		mapResponse
	};
}
function notificationSpec(method, params) {
	return {
		method,
		params
	};
}
function registerAppRequest(builder, spec, context, handler) {
	builder.onReceiveRequest(spec.method, (params) => parseParams(spec.params, params), async (params, responder, cx) => {
		const response = await handler(context(params, cx, responder.signal, responder.id));
		await responder.respond(spec.mapResponse ? spec.mapResponse(response) : response);
	});
}
function registerAppNotification(builder, spec, context, handler) {
	builder.onReceiveNotification(spec.method, (params) => parseParams(spec.params, params), (params, cx) => handler(context(params, cx, cx.signal)));
}
function specsByMethod(specs) {
	const byMethod = {};
	for (const spec of Object.values(specs)) byMethod[spec.method] = spec;
	return byMethod;
}
const agentRequestSpecs = {
	initialize: requestSpec(AGENT_METHODS.initialize, zInitializeRequest),
	newSession: requestSpec(AGENT_METHODS.session_new, zNewSessionRequest),
	loadSession: requestSpec(AGENT_METHODS.session_load, zLoadSessionRequest, emptyObjectResponse),
	unstable_forkSession: requestSpec(AGENT_METHODS.session_fork, zForkSessionRequest),
	listSessions: requestSpec(AGENT_METHODS.session_list, zListSessionsRequest),
	deleteSession: requestSpec(AGENT_METHODS.session_delete, zDeleteSessionRequest, emptyObjectResponse),
	resumeSession: requestSpec(AGENT_METHODS.session_resume, zResumeSessionRequest),
	closeSession: requestSpec(AGENT_METHODS.session_close, zCloseSessionRequest, emptyObjectResponse),
	setSessionMode: requestSpec(AGENT_METHODS.session_set_mode, zSetSessionModeRequest, emptyObjectResponse),
	setSessionConfigOption: requestSpec(AGENT_METHODS.session_set_config_option, zSetSessionConfigOptionRequest),
	authenticate: requestSpec(AGENT_METHODS.authenticate, zAuthenticateRequest, emptyObjectResponse),
	unstable_listProviders: requestSpec(AGENT_METHODS.providers_list, zListProvidersRequest),
	unstable_setProvider: requestSpec(AGENT_METHODS.providers_set, zSetProviderRequest, emptyObjectResponse),
	unstable_disableProvider: requestSpec(AGENT_METHODS.providers_disable, zDisableProviderRequest, emptyObjectResponse),
	logout: requestSpec(AGENT_METHODS.logout, zLogoutRequest, emptyObjectResponse),
	prompt: requestSpec(AGENT_METHODS.session_prompt, zPromptRequest),
	unstable_startNes: requestSpec(AGENT_METHODS.nes_start, zStartNesRequest),
	unstable_suggestNes: requestSpec(AGENT_METHODS.nes_suggest, zSuggestNesRequest),
	unstable_closeNes: requestSpec(AGENT_METHODS.nes_close, zCloseNesRequest, emptyObjectResponse)
};
const agentNotificationSpecs = {
	cancel: notificationSpec(AGENT_METHODS.session_cancel, zCancelNotification),
	unstable_didOpenDocument: notificationSpec(AGENT_METHODS.document_did_open, zDidOpenDocumentNotification),
	unstable_didChangeDocument: notificationSpec(AGENT_METHODS.document_did_change, zDidChangeDocumentNotification),
	unstable_didCloseDocument: notificationSpec(AGENT_METHODS.document_did_close, zDidCloseDocumentNotification),
	unstable_didSaveDocument: notificationSpec(AGENT_METHODS.document_did_save, zDidSaveDocumentNotification),
	unstable_didFocusDocument: notificationSpec(AGENT_METHODS.document_did_focus, zDidFocusDocumentNotification),
	unstable_acceptNes: notificationSpec(AGENT_METHODS.nes_accept, zAcceptNesNotification),
	unstable_rejectNes: notificationSpec(AGENT_METHODS.nes_reject, zRejectNesNotification)
};
const clientRequestSpecs = {
	requestPermission: requestSpec(CLIENT_METHODS.session_request_permission, zRequestPermissionRequest),
	writeTextFile: requestSpec(CLIENT_METHODS.fs_write_text_file, zWriteTextFileRequest, emptyObjectResponse),
	readTextFile: requestSpec(CLIENT_METHODS.fs_read_text_file, zReadTextFileRequest),
	createTerminal: requestSpec(CLIENT_METHODS.terminal_create, zCreateTerminalRequest),
	terminalOutput: requestSpec(CLIENT_METHODS.terminal_output, zTerminalOutputRequest),
	releaseTerminal: requestSpec(CLIENT_METHODS.terminal_release, zReleaseTerminalRequest, emptyObjectResponse),
	waitForTerminalExit: requestSpec(CLIENT_METHODS.terminal_wait_for_exit, zWaitForTerminalExitRequest),
	killTerminal: requestSpec(CLIENT_METHODS.terminal_kill, zKillTerminalRequest, emptyObjectResponse),
	createElicitation: requestSpec(CLIENT_METHODS.elicitation_create, zCreateElicitationRequest)
};
const clientNotificationSpecs = {
	sessionUpdate: notificationSpec(CLIENT_METHODS.session_update, zSessionNotification),
	completeElicitation: notificationSpec(CLIENT_METHODS.elicitation_complete, zCompleteElicitationNotification)
};
const agentRequestSpecsByMethod = specsByMethod(agentRequestSpecs);
specsByMethod(agentNotificationSpecs);
const clientRequestSpecsByMethod = specsByMethod(clientRequestSpecs);
const clientNotificationSpecsByMethod = specsByMethod(clientNotificationSpecs);
function clientRequestContext(params, agent, signal, requestId) {
	return {
		params,
		requestId,
		signal,
		agent
	};
}
function clientNotificationContext(params, agent, signal) {
	return {
		params,
		signal,
		agent
	};
}
var SessionUpdateRouter = class {
	activeSessions = /* @__PURE__ */ new Map();
	handleMessage(message) {
		if (message.kind !== "notification" || message.method !== CLIENT_METHODS.session_update) return Handled.no(message);
		const notification = zSessionNotification.parse(message.params);
		const update = {
			kind: "session_update",
			notification,
			update: notification.update
		};
		const activeSessions = this.activeSessions.get(notification.sessionId);
		if (activeSessions && activeSessions.size > 0) for (const session of activeSessions) session.enqueue(update);
		return Handled.no(message);
	}
	attach(response, updates) {
		const sessions = this.activeSessions.get(response.sessionId) ?? /* @__PURE__ */ new Set();
		sessions.add(updates);
		this.activeSessions.set(response.sessionId, sessions);
		return new HandlerRegistration(() => {
			sessions.delete(updates);
			if (sessions.size === 0) this.activeSessions.delete(response.sessionId);
		});
	}
};
const sessionUpdateRouters = /* @__PURE__ */ new WeakMap();
function sessionUpdateRouter(cx) {
	let router = sessionUpdateRouters.get(cx);
	if (!router) {
		router = new SessionUpdateRouter();
		sessionUpdateRouters.set(cx, router);
	}
	return router;
}
function runConnectHandlers(connection, handlers) {
	for (const handler of handlers) {
		let result;
		try {
			result = handler(connection);
		} catch (error) {
			connection.close(error);
			throw error;
		}
		Promise.resolve(result).catch((error) => {
			connection.close(error);
		});
	}
}
const appBuilder = Symbol("appBuilder");
const runAgentConnectHandlers = Symbol("runAgentConnectHandlers");
const runClientConnectHandlers = Symbol("runClientConnectHandlers");
const stableConnectionOptions = { allowBatches: false };
/**
* Creates a client-side app.
*
* Register request and notification handlers by ACP method name, then use
* `connectWith(...)` to run the workflow that calls agent-side methods.
*/
function client(options) {
	return new ClientApp(options);
}
/**
* Client-side app builder.
*
* Methods on this class register typed client handlers and return `this`, so
* apps can be built with a fluent chain. `connectWith(...)` is the usual entry
* point for clients because it provides a `ClientContext` for calling
* agent-side requests and session helpers.
*/
var ClientApp = class {
	builder = Connection.builder();
	connectHandlers = [];
	constructor(options = {}) {
		if (options.name) this.builder.name(options.name);
		this.builder.withHandler({
			handleMessage: (message, cx) => sessionUpdateRouter(cx).handleMessage(message),
			describe: () => "client-session-update-router"
		});
	}
	/** @internal */
	[appBuilder]() {
		return this.builder;
	}
	/** @internal */
	[runClientConnectHandlers](connection) {
		runConnectHandlers(connection, this.connectHandlers);
	}
	connect(target) {
		return this.connectConnection(target).connection;
	}
	connectWith(target, op) {
		const { rawConnection, connection } = this.connectConnection(target);
		return rawConnection.runUntil(() => op(connection.agent));
	}
	/**
	* Registers a handler that runs when this client app opens a connection.
	*
	* Use this for connection-scoped work that needs to call agent-side ACP
	* methods outside an inbound request handler.
	*/
	onConnect(handler) {
		this.connectHandlers.push(handler);
		return this;
	}
	onRequest(method, handlerOrParams, handler) {
		if (handler) return this.request({
			method,
			params: handlerOrParams
		}, handler);
		const spec = clientRequestSpecsByMethod[method];
		if (!spec) throw new Error(`Unknown ACP request method '${method}'. Pass a params parser for custom methods.`);
		return this.request(spec, handlerOrParams);
	}
	onNotification(method, handlerOrParams, handler) {
		if (handler) return this.notification({
			method,
			params: handlerOrParams
		}, handler);
		const spec = clientNotificationSpecsByMethod[method];
		if (!spec) throw new Error(`Unknown ACP notification method '${method}'. Pass a params parser for custom methods.`);
		return this.notification(spec, handlerOrParams);
	}
	request(spec, handler) {
		registerAppRequest(this.builder, spec, (params, cx, signal, requestId) => clientRequestContext(params, ClientContext.create(cx, requestId), signal, requestId), handler);
		return this;
	}
	notification(spec, handler) {
		registerAppNotification(this.builder, spec, (params, cx, signal) => clientNotificationContext(params, ClientContext.create(cx), signal), handler);
		return this;
	}
	connectConnection(target) {
		if (isStream(target)) {
			const state = this.openStreamConnection(target);
			this[runClientConnectHandlers](state.connection);
			return state;
		}
		const [thisStream, peerStream] = memoryStreamPair();
		const peerRawConnection = target[appBuilder]().connect(peerStream, stableConnectionOptions);
		const peerConnection = agentConnection(peerRawConnection);
		const state = this.openStreamConnection(thisStream);
		state.rawConnection.closed.then(() => peerConnection.close());
		peerRawConnection.closed.then(() => state.connection.close());
		try {
			target[runAgentConnectHandlers](peerConnection);
			this[runClientConnectHandlers](state.connection);
		} catch (error) {
			peerConnection.close(error);
			state.connection.close(error);
			throw error;
		}
		return state;
	}
	openStreamConnection(stream) {
		const rawConnection = this.builder.connect(stream, stableConnectionOptions);
		return {
			rawConnection,
			connection: clientConnection(rawConnection, this.connectHandlers)
		};
	}
};
new Set([
	AGENT_METHODS.initialize,
	AGENT_METHODS.authenticate,
	AGENT_METHODS.providers_list,
	AGENT_METHODS.providers_set,
	AGENT_METHODS.providers_disable,
	AGENT_METHODS.session_new,
	AGENT_METHODS.session_load,
	AGENT_METHODS.session_set_mode,
	AGENT_METHODS.session_set_config_option,
	AGENT_METHODS.session_prompt,
	AGENT_METHODS.session_list,
	AGENT_METHODS.session_delete,
	AGENT_METHODS.session_fork,
	AGENT_METHODS.session_resume,
	AGENT_METHODS.session_close,
	AGENT_METHODS.logout,
	AGENT_METHODS.nes_start,
	AGENT_METHODS.nes_suggest,
	AGENT_METHODS.nes_close
]);
new Set([
	AGENT_METHODS.session_cancel,
	AGENT_METHODS.nes_accept,
	AGENT_METHODS.nes_reject,
	AGENT_METHODS.document_did_open,
	AGENT_METHODS.document_did_change,
	AGENT_METHODS.document_did_close,
	AGENT_METHODS.document_did_save,
	AGENT_METHODS.document_did_focus
]);
new Set([
	CLIENT_METHODS.session_request_permission,
	CLIENT_METHODS.fs_write_text_file,
	CLIENT_METHODS.fs_read_text_file,
	CLIENT_METHODS.terminal_create,
	CLIENT_METHODS.terminal_output,
	CLIENT_METHODS.terminal_release,
	CLIENT_METHODS.terminal_wait_for_exit,
	CLIENT_METHODS.terminal_kill,
	CLIENT_METHODS.elicitation_create
]);
new Set([CLIENT_METHODS.session_update, CLIENT_METHODS.elicitation_complete]);
//#endregion
//#region src/host/service/child-env.ts
/**
* 子进程环境用**白名单**构造，不是「继承全部再剔除」。
*
* 黑名单在这里不成立，因为 CodeBuddy 的认证判定是「组合触发」的：宿主（WorkBuddy /
* CodeBuddy 桌面端）会向自身进程注入整套 IDE 客户端标识 ——
* `CLIENT_INFO_IDE_TYPE` / `CLIENT_INFO_PLATFORM` / `CLIENT_INFO_PLUGIN_NAME` /
* `CLIENT_INFO_PRODUCT_NAME` / `CLIENT_INFO_USER_AGENT_EXTENSION` /
* `CLIENT_INFO_MACHINE_ID`。这六项单独存在时 CLI 仍按独立账号登录；整套同时出现时
* 它会判定「我在宿主里跑」，切换成宿主集成认证、转而向宿主索要 token，于是
* `~/.codebuddy` 里的登录态根本不会被读取 —— 表现为 `--print` 的
* "Authentication required"，ACP 里则是 `stopReason: refusal` 配日志里的 401。
*
* 这一点在本仓库上真机验证过：摘掉 `SERVER__*` 后子进程能启动、`session/new` 也成功
* （那两步不碰模型），但真正 `session/prompt` 立刻 refusal；CLI 日志里是
* `Failed to recall prompt friction intent: Request failed with status code 401`。
* 同一份白名单在 `dsh-codebuddy`（子智能体版）上已经跑了很久，那边记的实测结论是：
* 干净环境 20 秒成功；六项里只加任意一项仍成功；六项同时存在 15 秒后认证失败。
*
* 另一个必须处理的点：宿主的网关端口（`SERVER__PORT` / `SERVER__HOST`）也在这个环境里。
* CodeBuddy CLI 启动时会 bind 一个本地网关端口并照读这两个变量，于是父子抢同一个
* 地址、子进程一启动就 `EADDRINUSE` 退出。白名单天然挡掉它们，CLI 自己 listen(0)。
*/
const SAFE_ENV_KEYS = [
	"SystemRoot",
	"SYSTEMROOT",
	"windir",
	"WINDIR",
	"ComSpec",
	"COMSPEC",
	"PATHEXT",
	"SystemDrive",
	"SYSTEMDRIVE",
	"USERPROFILE",
	"APPDATA",
	"LOCALAPPDATA",
	"PROGRAMDATA",
	"ALLUSERSPROFILE",
	"PROGRAMFILES",
	"ProgramFiles",
	"ProgramW6432",
	"ProgramFiles(x86)",
	"CommonProgramFiles",
	"CommonProgramFiles(x86)",
	"CommonProgramW6432",
	"TEMP",
	"TMP",
	"HOMEDRIVE",
	"HOMEPATH",
	"HOME",
	"USERNAME",
	"USERDOMAIN",
	"COMPUTERNAME",
	"NUMBER_OF_PROCESSORS",
	"PROCESSOR_ARCHITECTURE",
	"PROCESSOR_IDENTIFIER",
	"OS",
	"PSModulePath",
	"LANG",
	"LC_ALL"
];
/**
* 凭据形状的变量默认不转发，但这两个是 CodeBuddy 官方读登录态的入口：
* 用户显式设置时应当生效（否则等于把「用环境变量登录」的人踢下线）。
*/
const PASSTHROUGH_ENV = ["CODEBUDDY_AUTH_TOKEN", "CODEBUDDY_API_KEY"];
/**
* `inherit` 模式下仍然要挡掉的变量。
*
* 这几组不是「安全」问题，而是会直接改掉 CLI 的行为：`CLIENT_INFO_*` 六项凑齐会让它
* 判定在宿主里跑并转去要宿主 token（401）；`SERVER__*` 会和宿主抢网关端口；
* `CODEBUDDY_CONFIG_DIR` 会把它指到另一个配置目录、读不到自己的登录态。
*/
const HOSTILE_ENV = /^(?:CLIENT_INFO_|SERVER__|DSH_|CLAUDE_|CODEBUDDY_CONFIG_DIR)/;
/** 指向宿主机器的代理只服务宿主自身进程，外部 CLI 用不上。 */
const LOCAL_PROXY = /^(https?|socks5?):\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i;
const PROXY_KEYS = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy"
];
const NO_PROXY_KEYS = ["NO_PROXY", "no_proxy"];
/**
* PATH 里 Git Bash / MSYS 的项（`/c/...`、`/usr/bin`）对 Windows 的 cmd 没有意义，
* 留着只会让 CLI 的路径探测走偏，直接剔掉。
*/
function windowsPath(raw) {
	if (typeof raw !== "string" || raw.length === 0) return "";
	return raw.split(";").map((entry) => entry.trim()).filter((entry) => entry.length > 0 && !entry.startsWith("/")).join(";");
}
/**
* The environment an ACP child should start with.
*
* 与「继承再剔除」的差别不只是安全：白名单之外的一切都进不了子进程，所以宿主以后新增
* 某个同类变量时这里不需要跟着改。真正要加的按路由写进 profile 的 `env`，它最后合并。
*/
function childEnv(source = process.env, extra = {}, mode = "whitelist") {
	if (mode === "inherit") return inheritEnv(source, extra);
	const env = {};
	for (const key of SAFE_ENV_KEYS) {
		const value = source[key];
		if (value !== void 0) env[key] = value;
	}
	if (env.HOME === void 0 && env.USERPROFILE !== void 0) env.HOME = env.USERPROFILE;
	const path = windowsPath(source.PATH ?? source.Path);
	env.PATH = path.length > 0 ? path : "C:\\Windows\\system32;C:\\Windows;C:\\Windows\\System32\\Wbem";
	for (const key of PASSTHROUGH_ENV) {
		const value = source[key];
		if (value !== void 0 && value.length > 0) env[key] = value;
	}
	for (const key of PROXY_KEYS) {
		const value = source[key];
		if (value === void 0 || value.length === 0 || LOCAL_PROXY.test(value.trim())) continue;
		env[key] = value;
	}
	for (const key of NO_PROXY_KEYS) {
		const value = source[key];
		if (value !== void 0 && value.length > 0) env[key] = value;
	}
	return {
		...env,
		...extra
	};
}
/**
* `inherit`：继承宿主环境，只挡掉 {@link HOSTILE_ENV} 和指向本机的代理。
*
* 给「白名单漏了某个变量」的场景兜底——比如 Git Bash 的 HOME、用户自己的
* API key、内网代理。代价是宿主以后新增同类变量时会自动漏进来，所以默认不开。
*/
function inheritEnv(source, extra) {
	const env = {};
	for (const [key, value] of Object.entries(source)) {
		if (value === void 0 || HOSTILE_ENV.test(key)) continue;
		env[key] = value;
	}
	for (const key of PROXY_KEYS) {
		const value = env[key];
		if (value !== void 0 && LOCAL_PROXY.test(value.trim())) delete env[key];
	}
	return {
		...env,
		...extra
	};
}
//#endregion
//#region src/host/service/prompt-capabilities.ts
/** Read an `initialize` answer's prompt capabilities; every absent flag is a negative. */
function promptCapabilitiesOf(capabilities) {
	return {
		image: capabilities?.image === true,
		audio: capabilities?.audio === true,
		embeddedContext: capabilities?.embeddedContext === true
	};
}
function fingerprint(facts) {
	return createHash("sha256").update(facts).digest("hex").slice(0, 16);
}
function entryOf(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const record = value;
	return {
		facts: record.facts,
		image: record.image === true,
		audio: record.audio === true,
		embeddedContext: record.embeddedContext === true
	};
}
/**
* Prompt capabilities agents answered with during `initialize`, keyed by route. dsh asks a
* route what input it accepts before the user can attach anything, which is earlier than the
* first turn that would start the agent; with a `file` the last answer survives restarts, so
* a route reports image input straight away instead of claiming text only until it is used.
*
* Each entry remembers the spawn facts it came from: a route pointed at a different command
* answers for a different agent, so its stored answer is ignored until the new one speaks.
*/
var PromptCapabilitiesCache = class {
	entries = /* @__PURE__ */ new Map();
	saving = Promise.resolve();
	constructor(file, logger) {
		this.file = file;
		this.logger = logger;
		if (file === void 0) return;
		try {
			const stored = JSON.parse(readFileSync(file, "utf8"));
			for (const [route, value] of Object.entries(stored)) {
				const entry = entryOf(value);
				if (entry !== void 0 && typeof entry.facts === "string") this.entries.set(route, {
					...entry,
					facts: entry.facts
				});
			}
		} catch (error) {
			if (error.code !== "ENOENT") logger?.warn(`${PLUGIN_ID}: ignoring unreadable prompt capability cache ${file}`, error);
		}
	}
	get(route, facts) {
		const entry = this.entries.get(route);
		if (entry === void 0 || entry.facts !== fingerprint(facts)) return void 0;
		return {
			image: entry.image,
			audio: entry.audio,
			embeddedContext: entry.embeddedContext
		};
	}
	set(route, facts, capabilities) {
		const entry = {
			...capabilities,
			facts: fingerprint(facts)
		};
		const known = this.entries.get(route);
		if (known !== void 0 && known.facts === entry.facts && known.image === entry.image && known.audio === entry.audio && known.embeddedContext === entry.embeddedContext) return;
		this.entries.set(route, entry);
		const file = this.file;
		if (file === void 0) return;
		const snapshot = Object.fromEntries(this.entries);
		this.saving = this.saving.then(async () => {
			mkdirSync(dirname(file), { recursive: true });
			await writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`);
		}).catch((error) => {
			this.logger?.warn(`${PLUGIN_ID}: could not save prompt capability cache ${file}`, error);
		});
	}
	/** Settles once every answer stored so far is on disk. */
	flush() {
		return this.saving;
	}
};
//#endregion
//#region src/host/service/acp-agent.ts
const AUTH_REQUIRED_CODE = -32e3;
const STDERR_TAIL_BYTES = 4096;
/**
* How long a catalog probe may take.
*
* 模型发现是「打开选择器」时顺手做的旁路请求，不能把它变成第二次长时间转圈：Agent 正忙
* （正在跑一个回合）时 `session/new` 会排在后面，等多久取决于那一轮什么时候结束。超时就
* 认输，选择器退回单个 default，等用户下次打开再试。
*/
const DISCOVERY_TIMEOUT_MS = 25e3;
/**
* Whether spawning this command needs a shell.
*
* On Windows `spawn` with `shell: true` joins everything into one line for `cmd /c` **without
* quoting**, so a command living under `C:\Program Files\...` is split at the first space and
* dies as "not recognized". A real `.exe` therefore must never go through a shell. Only bare
* names (`npx`, `claude`) and `.cmd`/`.bat` shims need one — Node refuses to run those directly.
*/
function needsShell(command, platform = process.platform) {
	if (platform !== "win32") return false;
	return !/\.(?:exe|com)$/i.test(command);
}
function selectOption(options, category) {
	const option = options?.find((item) => item.category === category && item.type === "select");
	if (option === void 0 || option.type !== "select") return void 0;
	const available = option.options.flatMap((entry) => "group" in entry ? entry.options : [entry]).map((entry) => ({
		id: entry.value,
		name: entry.name,
		...entry.description ? { description: entry.description } : {}
	}));
	return {
		id: option.id,
		current: option.currentValue,
		available
	};
}
/** Read the `thought_level` select the agent offers, if any. */
function sessionEfforts(options) {
	const option = selectOption(options, "thought_level");
	return option === void 0 || option.available.length === 0 ? void 0 : {
		configId: option.id,
		current: option.current,
		initial: option.current,
		available: option.available
	};
}
/** Fold a fresh `configOptions` list (set_config_option answer or config_option_update) into a session. */
function applyConfigOptions(session, options) {
	const model = selectOption(options, "model");
	if (model !== void 0 && session.models.configId === model.id) session.models.current = model.current;
	const efforts = sessionEfforts(options);
	if (efforts !== void 0) session.efforts = {
		...efforts,
		initial: session.efforts?.initial ?? efforts.initial
	};
	else if (options?.some((item) => item.id === session.efforts?.configId) === false) delete session.efforts;
}
function sessionModels(response) {
	const option = selectOption(response.configOptions, "model");
	if (option !== void 0) return {
		configId: option.id,
		legacy: false,
		current: option.current,
		available: option.available
	};
	const legacy = Reflect.get(response, "models");
	if (legacy?.availableModels !== void 0) return {
		legacy: true,
		...legacy.currentModelId === void 0 ? {} : { current: legacy.currentModelId },
		available: legacy.availableModels.map((entry) => ({
			id: entry.modelId,
			name: entry.name ?? entry.modelId,
			...entry.description ? { description: entry.description } : {}
		}))
	};
	return {
		legacy: false,
		available: []
	};
}
function describeError(error) {
	if (error instanceof Error) return error.message;
	if (typeof error === "object" && error !== null && typeof Reflect.get(error, "message") === "string") return Reflect.get(error, "message");
	return String(error);
}
function errorCode(error) {
	return typeof error === "object" && error !== null ? Reflect.get(error, "code") : void 0;
}
function abortError() {
	return new LlmError("ACP request was aborted", "ABORTED");
}
var AcpAgentProcess = class {
	live;
	starting;
	generationCounter = 0;
	disposed = false;
	stderrTail = "";
	listeners = /* @__PURE__ */ new Map();
	liveCwd;
	lastCwd;
	advertised;
	efforts;
	discovering;
	/**
	* ACP 一次只处理一个 `session/prompt`。dsh 每轮还会并发一个标题生成的
	* ephemeral 会话，两个请求同时飞会互相排队甚至丢更新，所以在这一层串起来。
	*/
	gate = Promise.resolve();
	constructor(options) {
		this.options = options;
	}
	get generation() {
		return this.live?.generation ?? -1;
	}
	/** What the running agent said it accepts in a prompt; undefined until it has spoken. */
	get promptCapabilities() {
		const live = this.live;
		return live === void 0 ? void 0 : promptCapabilitiesOf(live.init.agentCapabilities?.promptCapabilities);
	}
	get supportsImages() {
		return this.promptCapabilities?.image === true;
	}
	/**
	* Ask the agent itself what prompt content it accepts. ACP answers that in `initialize`,
	* so the handshake alone is enough — no session and no turn.
	*/
	async probeCapabilities(signal) {
		return promptCapabilitiesOf((await this.ensure(signal)).init.agentCapabilities?.promptCapabilities);
	}
	get advertisedModels() {
		return this.advertised;
	}
	/** The thought levels the agent offered on its latest session, if it offers any. */
	get advertisedEfforts() {
		return this.efforts;
	}
	async newSession(cwd, signal) {
		const live = await this.ensure(signal, cwd);
		let response;
		try {
			response = await this.withAbort(live.connection.agent.request(methods.agent.session.new, {
				cwd,
				mcpServers: []
			}), signal);
		} catch (error) {
			if (error instanceof LlmError) throw error;
			if (errorCode(error) === AUTH_REQUIRED_CODE) {
				const available = (live.init.authMethods ?? []).map((method) => method.id).join(", ");
				throw new LlmError(`${PLUGIN_ID}: ACP agent "${this.options.route}" requires authentication; sign in with the agent's own CLI or set authMethod${available.length > 0 ? ` (one of: ${available})` : ""} — ${describeError(error)}`, "MISSING_CREDENTIAL", { cause: error });
			}
			throw this.transportError("session/new", error);
		}
		const models = sessionModels(response);
		if (models.available.length > 0) this.advertised = models.available;
		const efforts = sessionEfforts(response.configOptions);
		this.efforts = efforts;
		return {
			sessionId: response.sessionId,
			generation: live.generation,
			models,
			...efforts === void 0 ? {} : { efforts }
		};
	}
	async selectModel(session, model, signal) {
		if (model === "default" || model === session.models.current) return;
		const live = this.requireLive(session.generation);
		const { configId, legacy } = session.models;
		try {
			if (configId !== void 0) applyConfigOptions(session, (await this.withAbort(live.connection.agent.request(methods.agent.session.setConfigOption, {
				sessionId: session.sessionId,
				configId,
				value: model
			}), signal)).configOptions);
			else if (legacy) await this.withAbort(live.connection.agent.request("session/set_model", {
				sessionId: session.sessionId,
				modelId: model
			}), signal);
			else throw new LlmError(`${PLUGIN_ID}: ACP agent "${this.options.route}" does not expose model selection; use model "${DEFAULT_MODEL_ID}"`, "MODEL_NOT_FOUND");
		} catch (error) {
			if (error instanceof LlmError) throw error;
			throw new LlmError(`${PLUGIN_ID}: ACP agent "${this.options.route}" rejected model "${model}": ${describeError(error)}`, "MODEL_NOT_FOUND", { cause: error });
		}
		session.models.current = model;
	}
	/**
	* Apply a dsh reasoning effort through the agent's `thought_level` option. Unknown efforts
	* (the model changed the offered levels) keep the agent's current level.
	*/
	async selectEffort(session, effort, signal) {
		const efforts = session.efforts;
		if (efforts === void 0 || efforts.current === effort) return;
		if (!efforts.available.some((level) => level.id === effort)) {
			this.options.logger.warn(`${PLUGIN_ID}: ACP agent "${this.options.route}" does not offer reasoning effort "${effort}"; keeping "${efforts.current ?? "default"}"`);
			return;
		}
		const live = this.requireLive(session.generation);
		try {
			const response = await this.withAbort(live.connection.agent.request(methods.agent.session.setConfigOption, {
				sessionId: session.sessionId,
				configId: efforts.configId,
				value: effort
			}), signal);
			efforts.current = effort;
			applyConfigOptions(session, response.configOptions);
		} catch (error) {
			if (error instanceof LlmError) throw error;
			throw new LlmError(`${PLUGIN_ID}: ACP agent "${this.options.route}" rejected reasoning effort "${effort}": ${describeError(error)}`, "INVALID_REQUEST", { cause: error });
		}
	}
	async prompt(session, prompt, onUpdate) {
		const live = this.requireLive(session.generation);
		const previous = this.gate;
		let release;
		this.gate = new Promise((resolve) => {
			release = resolve;
		});
		await previous.catch(() => {});
		this.listeners.set(session.sessionId, onUpdate);
		try {
			return await live.connection.agent.request(methods.agent.session.prompt, {
				sessionId: session.sessionId,
				prompt
			});
		} catch (error) {
			throw this.transportError("session/prompt", error);
		} finally {
			if (this.listeners.get(session.sessionId) === onUpdate) this.listeners.delete(session.sessionId);
			release();
		}
	}
	cancel(session) {
		const live = this.live;
		if (live === void 0 || live.generation !== session.generation) return;
		live.connection.agent.notify(methods.agent.session.cancel, { sessionId: session.sessionId }).catch(() => {});
	}
	closeSession(session) {
		const live = this.live;
		if (live === void 0 || live.generation !== session.generation) return;
		if (!Reflect.get(live.init.agentCapabilities?.sessionCapabilities ?? {}, "close")) return;
		live.connection.agent.request(methods.agent.session.close, { sessionId: session.sessionId }).catch(() => {});
	}
	async discoverModels(cwd, signal) {
		if (this.advertised !== void 0) return this.advertised;
		this.discovering ??= this.timed(DISCOVERY_TIMEOUT_MS, `did not answer session/new within ${DISCOVERY_TIMEOUT_MS}ms while listing models`, this.newSession(this.liveCwd ?? this.lastCwd ?? cwd).then((session) => {
			this.closeSession(session);
			this.advertised ??= session.models.available;
			return this.advertised;
		})).finally(() => {
			this.discovering = void 0;
		});
		return this.withAbort(this.discovering, signal);
	}
	restart() {
		this.advertised = void 0;
		this.efforts = void 0;
		this.discovering = void 0;
		this.teardown();
	}
	dispose() {
		this.disposed = true;
		this.teardown();
	}
	teardown() {
		const live = this.live;
		this.live = void 0;
		this.liveCwd = void 0;
		this.starting = void 0;
		this.listeners.clear();
		if (live === void 0) return;
		live.connection.close();
		live.child.stdin?.end();
		if (live.child.exitCode === null && live.child.signalCode === null) live.child.kill("SIGTERM");
	}
	requireLive(generation) {
		const live = this.live;
		if (live === void 0 || live.generation !== generation) throw new LlmError(`${PLUGIN_ID}: ACP agent "${this.options.route}" restarted during the request`, "TRANSPORT");
		return live;
	}
	/**
	* @param cwd 这次要用的工作目录（dsh 会话的 workspace）。子进程的 shell 必须和 ACP
	* 会话报的目录一致：CodeBuddy 的 Bash 工具跟随进程 cwd，两者不一致时它会发现
	* 「runtime context 说 A、我的 shell 在 B」，然后停下来反问用户。
	*/
	ensure(signal, cwd) {
		if (this.disposed) return Promise.reject(new LlmError(`${PLUGIN_ID}: ACP agent "${this.options.route}" was disposed`, "TRANSPORT"));
		if (this.live !== void 0) {
			if (cwd === void 0 || this.liveCwd === void 0 || cwd === this.liveCwd) return Promise.resolve(this.live);
			this.options.logger.info(`${PLUGIN_ID}: ACP agent "${this.options.route}" restarts for working directory "${cwd}"`);
			this.restart();
		}
		this.starting ??= this.start(cwd).finally(() => {
			this.starting = void 0;
		});
		return this.withAbort(this.starting, signal);
	}
	async start(cwdHint) {
		const profile = this.options.profile();
		const generation = ++this.generationCounter;
		this.stderrTail = "";
		const cwd = profile.cwd ?? cwdHint ?? this.lastCwd ?? homedir();
		this.lastCwd = cwd;
		const child = spawn(profile.command, profile.args, {
			cwd,
			env: childEnv(process.env, profile.env, profile.envMode),
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			],
			windowsHide: true,
			shell: needsShell(profile.command)
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk) => {
			this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
		});
		const exited = new Promise((_, reject) => {
			child.once("error", (error) => reject(this.startError(`failed to spawn "${profile.command}": ${error.message}`, error)));
			child.once("exit", (code, sig) => reject(this.startError(`agent exited during startup (code ${code ?? "null"}, signal ${sig ?? "null"})`)));
		});
		exited.catch(() => {});
		const connection = client({ name: PLUGIN_ID }).onNotification(methods.client.session.update, ({ params }) => {
			this.listeners.get(params.sessionId)?.(params.update);
			return Promise.resolve();
		}).onRequest(methods.client.session.requestPermission, ({ params }) => this.options.onPermission(params.sessionId, params)).connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
		let timer;
		const timeout = new Promise((_, reject) => {
			timer = setTimeout(() => reject(this.startError(`initialize timed out after ${profile.startupTimeoutMs}ms`)), profile.startupTimeoutMs);
		});
		let init;
		try {
			init = await Promise.race([
				connection.agent.request(methods.agent.initialize, {
					protocolVersion: 1,
					clientCapabilities: {},
					clientInfo: {
						name: PLUGIN_ID,
						version: "0.2.0"
					}
				}),
				exited,
				timeout
			]);
		} catch (error) {
			connection.close();
			if (child.exitCode === null) child.kill("SIGKILL");
			throw error instanceof LlmError ? error : this.startError(`initialize failed: ${describeError(error)}`, error);
		} finally {
			clearTimeout(timer);
		}
		if (profile.authMethod !== void 0) try {
			await Promise.race([connection.agent.request(methods.agent.authenticate, { methodId: profile.authMethod }), exited]);
		} catch (error) {
			connection.close();
			if (child.exitCode === null) child.kill("SIGKILL");
			const available = (init.authMethods ?? []).map((method) => method.id).join(", ");
			throw new LlmError(`${PLUGIN_ID}: ACP agent "${this.options.route}" rejected authMethod "${profile.authMethod}"${available.length > 0 ? ` (available: ${available})` : ""}: ${describeError(error)}${this.stderrSuffix()}`, "MISSING_CREDENTIAL", { cause: error });
		}
		const live = {
			child,
			connection,
			init,
			generation
		};
		child.removeAllListeners("exit");
		child.once("exit", (code, sig) => {
			if (this.live === live) {
				this.options.logger.warn(`${PLUGIN_ID}: ACP agent "${this.options.route}" exited (code ${code ?? "null"}, signal ${sig ?? "null"})${this.stderrSuffix()}`);
				this.live = void 0;
				this.listeners.clear();
				connection.close();
			}
		});
		this.live = live;
		this.liveCwd = cwd;
		this.options.onCapabilities?.(promptCapabilitiesOf(init.agentCapabilities?.promptCapabilities));
		return live;
	}
	stderrSuffix() {
		const tail = this.stderrTail.trim();
		return tail.length === 0 ? "" : `\n${tail}${this.portHint(tail)}`;
	}
	/**
	* CodeBuddy 系 CLI 启动时会 bind 一个本地网关端口，被占就直接退出，stderr 只留一行
	* EADDRINUSE，上层只能看到「ACP connection closed」。
	*
	* 最常见的成因是宿主的 `SERVER__PORT` 被继承下来（见 `child-env.ts`，插件的默认行为已经
	* 把它摘掉了），所以现在还撞上，就只剩两种可能：别的 CodeBuddy 系进程真的占着那个端口，
	* 或者 profile 的 `env` 又把它写回去了。
	*/
	portHint(tail) {
		if (!tail.includes("EADDRINUSE")) return "";
		return "\n  hint: the agent could not bind its local gateway port. The plugin strips SERVER__PORT / CODEBUDDY_* from the child environment by default, so this now means either another CodeBuddy-family process (CodeBuddy CLI, WorkBuddy, a leaked run) owns that port, or this route's `env` sets it again.";
	}
	startError(message, cause) {
		return new LlmError(`${PLUGIN_ID}: ACP agent "${this.options.route}" ${message}${this.stderrSuffix()}`, "TRANSPORT", cause === void 0 ? void 0 : { cause });
	}
	transportError(stage, error) {
		if (error instanceof LlmError) return error;
		return new LlmError(`${PLUGIN_ID}: ACP agent "${this.options.route}" ${stage} failed: ${describeError(error)}${this.stderrSuffix()}`, "TRANSPORT", { cause: error });
	}
	withAbort(promise, signal) {
		if (signal === void 0) return promise;
		if (signal.aborted) return Promise.reject(abortError());
		return new Promise((resolve, reject) => {
			const onAbort = () => reject(abortError());
			signal.addEventListener("abort", onAbort, { once: true });
			promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
		});
	}
	/** Reject with a named reason instead of waiting forever for an agent that never answers. */
	async timed(ms, why, action) {
		let timer;
		const timeout = new Promise((_, reject) => {
			timer = setTimeout(() => reject(new LlmError(`${PLUGIN_ID}: ACP agent "${this.options.route}" ${why}`, "TRANSPORT")), ms);
		});
		action.catch(() => {});
		try {
			return await Promise.race([action, timeout]);
		} finally {
			clearTimeout(timer);
		}
	}
};
//#endregion
//#region src/host/service/chunk-translator.ts
/** 从 tool_call 的 rawInput 里挑一个最像「在哪儿/做了什么」的字段，压成一行。 */
function describeInput(rawInput) {
	if (typeof rawInput !== "object" || rawInput === null) return "";
	const record = rawInput;
	for (const key of [
		"file_path",
		"path",
		"notebook_path",
		"command",
		"pattern",
		"query",
		"url"
	]) {
		const value = record[key];
		if (typeof value !== "string" || value.length === 0) continue;
		const text = value.replace(/\s+/g, " ").trim();
		return ` · ${text.length > 80 ? `${text.slice(0, 80)}…` : text}`;
	}
	return "";
}
const PLAN_MARK = {
	pending: "[ ]",
	in_progress: "[~]",
	completed: "[x]"
};
const TERMINAL_STATUS = new Set(["completed", "failed"]);
var ChunkTranslator = class {
	open;
	nextIndex = 0;
	tools = /* @__PURE__ */ new Map();
	constructor(showToolCalls) {
		this.showToolCalls = showToolCalls;
	}
	get emittedBlocks() {
		return this.nextIndex;
	}
	push(update) {
		switch (update.sessionUpdate) {
			case "agent_message_chunk": return update.content.type === "text" ? this.append("text", update.content.text) : [];
			case "agent_thought_chunk": return update.content.type === "text" ? this.append("reasoning", update.content.text) : [];
			case "tool_call": {
				if (!this.showToolCalls) return [];
				this.tools.set(update.toolCallId, {
					title: update.title,
					status: update.status
				});
				const status = update.status !== void 0 && TERMINAL_STATUS.has(update.status) ? ` (${update.status})` : "";
				return this.append("reasoning", `${this.separator()}▸ [${update.kind ?? "tool"}] ${update.title}${describeInput(update.rawInput)}${status}\n`);
			}
			case "tool_call_update": {
				if (!this.showToolCalls) return [];
				const known = this.tools.get(update.toolCallId) ?? {
					title: update.toolCallId,
					status: void 0
				};
				const title = update.title ?? known.title;
				const status = update.status ?? known.status;
				const changed = status !== known.status && status !== void 0 && TERMINAL_STATUS.has(status);
				this.tools.set(update.toolCallId, {
					title,
					status: status ?? void 0
				});
				return changed ? this.append("reasoning", `  ↳ ${title}: ${status}\n`) : [];
			}
			case "plan": {
				if (!this.showToolCalls || update.entries.length === 0) return [];
				const lines = update.entries.map((entry) => `${PLAN_MARK[entry.status] ?? "[ ]"} ${entry.content}`);
				return this.append("reasoning", `${this.separator()}Plan:\n${lines.join("\n")}\n`);
			}
			default: return [];
		}
	}
	close() {
		const open = this.open;
		if (open === void 0) return [];
		this.open = void 0;
		return [{
			type: "block-end",
			index: open.index,
			block: open.kind === "text" ? {
				type: "text",
				text: open.text
			} : {
				type: "reasoning",
				text: open.text
			}
		}];
	}
	separator() {
		const open = this.open;
		return open?.kind === "reasoning" && open.text.length > 0 && !open.text.endsWith("\n") ? "\n" : "";
	}
	append(kind, text) {
		if (text.length === 0) return [];
		const chunks = [];
		if (this.open?.kind !== kind) {
			chunks.push(...this.close());
			this.open = {
				kind,
				index: this.nextIndex++,
				text: ""
			};
			chunks.push({
				type: "block-start",
				index: this.open.index,
				blockType: kind
			});
		}
		const open = this.open;
		open.text += text;
		chunks.push(kind === "text" ? {
			type: "text-delta",
			index: open.index,
			text
		} : {
			type: "reasoning-delta",
			index: open.index,
			text
		});
		return chunks;
	}
};
function delta(current, previous) {
	return Math.max(0, (current ?? 0) - (previous ?? 0));
}
function usageDelta(current, previous) {
	const usage = {
		inputTokens: delta(current.inputTokens, previous?.inputTokens),
		outputTokens: delta(current.outputTokens, previous?.outputTokens),
		totalTokens: delta(current.totalTokens, previous?.totalTokens)
	};
	const cacheRead = delta(current.cachedReadTokens, previous?.cachedReadTokens);
	const cacheWrite = delta(current.cachedWriteTokens, previous?.cachedWriteTokens);
	const reasoning = delta(current.thoughtTokens, previous?.thoughtTokens);
	if (cacheRead > 0) usage.cacheReadTokens = cacheRead;
	if (cacheWrite > 0) usage.cacheWriteTokens = cacheWrite;
	if (reasoning > 0) usage.reasoningTokens = reasoning;
	return usage;
}
//#endregion
//#region src/host/service/context-windows.ts
const ONE_MILLION = 1e6;
/**
* Window implied by a model's own id, name or description. ACP has no field for it before
* a turn runs, but agents spell 1M-context variants with a distinct "1m" token
* (`claude-fable-5-1[1m]`, `Opus 4.7 (1M context)`); `\b` keeps "10m" from matching.
*/
function inferContextWindow(...texts) {
	return texts.some((text) => text !== void 0 && /\b1m\b/i.test(text)) ? ONE_MILLION : void 0;
}
function keyOf(route, model) {
	return `${route}\u0000${model}`;
}
/**
* Context window sizes agents reported through `usage_update`, keyed by route and model.
* dsh resolves a model's window before each request, so a size learned only in memory
* leaves the first turn after every restart on the configured default; with a `file`
* the sizes survive restarts.
*/
var ContextWindows = class {
	sizes = /* @__PURE__ */ new Map();
	saving = Promise.resolve();
	constructor(file, logger) {
		this.file = file;
		this.logger = logger;
		if (file === void 0) return;
		try {
			const stored = JSON.parse(readFileSync(file, "utf8"));
			for (const [route, models] of Object.entries(stored)) for (const [model, size] of Object.entries(models)) if (typeof size === "number" && size > 0) this.sizes.set(keyOf(route, model), size);
		} catch (error) {
			if (error.code !== "ENOENT") logger?.warn(`${PLUGIN_ID}: ignoring unreadable context window cache ${file}`, error);
		}
	}
	get(route, model) {
		return this.sizes.get(keyOf(route, model));
	}
	set(route, model, size) {
		const key = keyOf(route, model);
		if (this.sizes.get(key) === size) return;
		this.sizes.set(key, size);
		const file = this.file;
		if (file === void 0) return;
		const snapshot = {};
		for (const [entry, value] of this.sizes) {
			const [entryRoute, entryModel] = entry.split("\0");
			(snapshot[entryRoute] ??= {})[entryModel] = value;
		}
		this.saving = this.saving.then(async () => {
			mkdirSync(dirname(file), { recursive: true });
			await writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`);
		}).catch((error) => {
			this.logger?.warn(`${PLUGIN_ID}: could not save context window cache ${file}`, error);
		});
	}
	/** Settles once every size set so far is on disk. */
	flush() {
		return this.saving;
	}
};
//#endregion
//#region src/host/service/permission.ts
const READ_ONLY_KINDS = new Set([
	"read",
	"search",
	"think",
	"fetch"
]);
function pick(options, kinds) {
	for (const kind of kinds) {
		const option = options.find((entry) => entry.kind === kind);
		if (option !== void 0) return option;
	}
}
function allow(request) {
	const option = pick(request.options, ["allow_once", "allow_always"]);
	return option === void 0 ? reject(request) : { outcome: {
		outcome: "selected",
		optionId: option.optionId
	} };
}
function reject(request) {
	const option = pick(request.options, ["reject_once", "reject_always"]);
	return option === void 0 ? { outcome: { outcome: "cancelled" } } : { outcome: {
		outcome: "selected",
		optionId: option.optionId
	} };
}
function readOnly(request) {
	const kind = request.toolCall.kind ?? "other";
	return READ_ONLY_KINDS.has(kind) ? allow(request) : reject(request);
}
async function decidePermission(host, route, policy, turn, request) {
	switch (policy) {
		case "allow": return allow(request);
		case "reject": return reject(request);
		case "read-only": return readOnly(request);
		case "ask": break;
	}
	const agent = turn?.dshSessionId === void 0 ? void 0 : host.agentOf(turn.dshSessionId);
	if (agent === void 0 || host.approve === void 0) {
		host.logger.warn(`${PLUGIN_ID}: no approval answerer for ACP agent "${route}"; falling back to read-only permission`);
		return readOnly(request);
	}
	const kind = request.toolCall.kind ?? "other";
	const title = request.toolCall.title ?? kind;
	try {
		return await host.approve({
			agent,
			toolName: `${route} · ${kind}`,
			reason: title,
			...turn?.signal === void 0 ? {} : { signal: turn.signal }
		}) === "allowed-once" ? allow(request) : reject(request);
	} catch (error) {
		host.logger.warn(`${PLUGIN_ID}: approval for ACP agent "${route}" failed; rejecting`, error);
		return reject(request);
	}
}
//#endregion
//#region src/host/service/transcript.ts
const CONTINUE_PROMPT = "Continue.";
function blockText(block) {
	switch (block.type) {
		case "text": return block.text;
		case "image": return block.offloaded === true ? offloadedImageText(block.attachment) : textOnlyImageText(block.attachment);
		case "file": return fileHandleText(block.attachment, void 0);
		case "tool-call": return `[tool call ${block.name} ${block.arguments}]`;
		default: return;
	}
}
function messageText(message) {
	return message.content.map(blockText).filter((text) => text !== void 0 && text.length > 0).join("\n");
}
/**
* One content block as the agent sees it: the image bytes read for this turn plus their
* handle text, else whatever text stands in for the block. An image nobody has read yet is
* recorded as wanted, so the caller can read it and build the prompt again.
*/
function blockParts(block, images) {
	if (block.type === "image" && images !== void 0 && block.offloaded !== true) {
		const id = String(block.attachment.attachmentId);
		const image = images.read.get(id);
		if (image !== void 0) return [{
			type: "text",
			text: requestImageHandleText(block.attachment, image)
		}, {
			type: "image",
			data: image.data,
			mimeType: image.mimeType
		}];
		images.wanted.set(id, block.attachment);
	}
	const text = blockText(block);
	return text === void 0 || text.length === 0 ? [] : [{
		type: "text",
		text
	}];
}
function toAcpBlocks(messages, images) {
	const blocks = messages.flatMap((message) => message.content.flatMap((block) => blockParts(block, images)));
	return blocks.length > 0 ? blocks : [{
		type: "text",
		text: CONTINUE_PROMPT
	}];
}
/**
* Prompt blocks under construction. Text accumulates into one block until an image has to
* break the run, so a transcript without images is still sent as the single block it was.
*/
var BlockWriter = class {
	blocks = [];
	pending = "";
	write(text, separator = "\n") {
		if (text.length === 0) return;
		this.pending = this.pending.length === 0 ? text : `${this.pending}${separator}${text}`;
	}
	attach(block) {
		this.flush();
		this.blocks.push(block);
	}
	flush() {
		if (this.pending.length === 0) return;
		this.blocks.push({
			type: "text",
			text: this.pending
		});
		this.pending = "";
	}
	done() {
		this.flush();
		return this.blocks;
	}
};
const ROLE_LABEL = {
	user: "User",
	assistant: "Assistant",
	tool: "Tool result"
};
function systemText(options) {
	const parts = options.messages.filter((message) => message.role === "system").map(messageText);
	if (options.system !== void 0) parts.unshift(options.system);
	return parts.filter((part) => part.length > 0).join("\n\n");
}
function conversationOf(options) {
	return options.messages.filter((message) => message.role !== "system");
}
function consumedIds(conversation) {
	return conversation.flatMap((message) => message.id === void 0 ? [] : [message.id]);
}
function incrementalPrompt(conversation, consumed, route, images) {
	if (consumed.length > conversation.length) return void 0;
	for (const [index, id] of consumed.entries()) if (conversation[index]?.id !== id) return void 0;
	const fresh = [];
	for (const message of conversation.slice(consumed.length)) {
		if (message.role === "assistant") {
			if (message.source.provider === route && fresh.length === 0) continue;
			return;
		}
		if (message.role === "tool") return void 0;
		if (message.role === "user") fresh.push(message);
	}
	return toAcpBlocks(fresh, images);
}
/**
* The replayed history. Text is labelled by role as one run; an image the turn can send is
* attached in place, so rebuilding a session does not silently blind the agent to pictures
* the user already sent.
*/
function writeHistory(writer, history, images) {
	const messages = history.filter((message) => message.role in ROLE_LABEL).map((message) => [ROLE_LABEL[message.role], message.content.flatMap((block) => blockParts(block, images))]).filter(([, parts]) => parts.length > 0);
	if (messages.length === 0) return;
	writer.write("<conversation_history>", "\n\n");
	for (const [order, [label, parts]] of messages.entries()) {
		let labelled = false;
		for (const [index, part] of parts.entries()) {
			const separator = index === 0 && order > 0 ? "\n\n" : "\n";
			if (part.type === "text") {
				writer.write(labelled ? part.text : `${label}: ${part.text}`, separator);
				labelled = true;
				continue;
			}
			if (!labelled) {
				writer.write(`${label}:`, separator);
				labelled = true;
			}
			writer.attach(part);
		}
	}
	writer.write("</conversation_history>");
}
function fullPrompt(conversation, system, images) {
	let split = conversation.length;
	while (split > 0 && conversation[split - 1]?.role === "user") split--;
	const writer = new BlockWriter();
	if (system !== void 0 && system.length > 0) writer.write(`<system_instructions>\n${system}\n</system_instructions>`);
	writeHistory(writer, conversation.slice(0, split), images);
	const preface = writer.done();
	const blocks = toAcpBlocks(conversation.slice(split), images);
	return preface.length === 0 ? blocks : [...preface, ...blocks];
}
//#endregion
//#region src/host/service/turn-trace.ts
/**
* 一次模型回合的轨迹。
*
* 为什么要有它：ACP 这一侧最容易出的故障是「某个请求发出去就没回来」，此时界面上只会
* 一直转圈，插件自己也停在某个 await 上 —— 既没有异常，也没有日志。所以这里按阶段
* **逐条落盘**（而不是结束时汇总），卡住时最后一行的 `stage` 就是卡住的位置。
*
* 体积控制：一行一百多字节，一次回合三四行；超过上限就轮转成 `.1`。
*/
const MAX_BYTES = 256 * 1024;
var TurnTrace = class {
	lines = [];
	flushed = 0;
	textBlocks = 0;
	textChars = 0;
	reasoningBlocks = 0;
	toolCalls = 0;
	updates = 0;
	startedAt = Date.now();
	constructor(file) {
		this.file = file;
	}
	start(fields) {
		this.push({
			t: "start",
			...fields
		});
	}
	/** 记下「正要等这一步」。它会立刻落盘，所以卡住时的最后一行就是卡住的位置。 */
	stage(name) {
		this.push({
			t: "stage",
			name,
			ms: Date.now() - this.startedAt
		});
	}
	/** 一条 ACP 通知的摘要：只累计数量与正文长度，正文留一小截方便认出在说什么。 */
	update(kind, text) {
		this.updates++;
		switch (kind) {
			case "agent_message_chunk":
				if (text !== void 0 && text.length > 0) {
					this.textBlocks++;
					this.textChars += text.length;
				}
				break;
			case "agent_thought_chunk":
				this.reasoningBlocks++;
				break;
			case "tool_call":
			case "tool_call_update":
				this.toolCalls++;
				break;
			default: break;
		}
	}
	end(fields) {
		this.push({
			t: "end",
			stopReason: fields.stopReason,
			ms: fields.ms,
			textChunks: this.textBlocks,
			textChars: this.textChars,
			reasoningChunks: this.reasoningBlocks,
			toolCalls: this.toolCalls,
			updates: this.updates,
			...fields.error === void 0 ? {} : { error: fields.error }
		});
	}
	push(line) {
		this.lines.push(`${JSON.stringify(line)}\n`);
		this.flush();
	}
	flush() {
		if (this.file === void 0 || this.lines.length === this.flushed) return;
		const chunk = this.lines.slice(this.flushed).join("");
		this.flushed = this.lines.length;
		try {
			rotate(this.file);
			appendFileSync(this.file, chunk);
		} catch {}
	}
};
function rotate(file) {
	try {
		if (statSync(file).size < MAX_BYTES) return;
		renameSync(file, `${file}.1`);
	} catch {}
}
//#endregion
//#region src/host/service/acp-adapter.ts
const TEXT_ONLY = ["text"];
const TEXT_AND_IMAGE = ["text", "image"];
const NO_RETRY = {
	mode: "normal",
	maxRetries: 0
};
const CANCEL_GRACE_MS = 5e3;
/**
* 提问前的配置类请求（选模型、选推理等级）本该在毫秒级返回。给它们一个上限，是为了让
* 「Agent 收下请求却不回应」表现为一条明确的错误，而不是界面上一圈永远转下去。
*/
const STAGE_TIMEOUT_MS = 2e4;
function promptHead(blocks) {
	const text = blocks.map((block) => block.type === "text" ? block.text : "").join(" ").trim();
	return text.length <= 60 ? text : `${text.slice(0, 60)}…`;
}
function spawnFacts(profile) {
	return JSON.stringify([
		profile.command,
		profile.args,
		profile.env,
		profile.cwd ?? null,
		profile.authMethod ?? null
	]);
}
function failure(code, message) {
	return {
		code,
		message
	};
}
function failureOf(error) {
	const known = typeof error === "object" && error !== null ? Reflect.get(error, "failure") : void 0;
	if (typeof known?.code === "string" && typeof known.message === "string") return failure(known.code, known.message);
	return failure("TRANSPORT", error instanceof Error ? error.message : String(error));
}
/** 12835 → "12.8K"，1000000 → "1.0M"。 */
function formatTokens(count) {
	if (count >= 1e6) return `${(count / 1e6).toFixed(1)}M`;
	if (count >= 1e3) return `${(count / 1e3).toFixed(1)}K`;
	return String(count);
}
const CONTEXT_CATEGORIES = [
	["systemPrompt", "提示词"],
	["tools", "工具"],
	["conversation", "对话"],
	["mcp", "MCP"],
	["skills", "技能"]
];
/**
* 一轮结束时补一行「上下文构成」。
*
* CodeBuddy 在 `usage_update._meta["codebuddy.ai/usageByCategory"]` 里给了分类明细，
* 但 ACP 的 `TokenUsage` 只有 input / output / cache 三类，分类在适配层就被丢掉了。
* dsh 自己的上下文面板按字符估算 dsh 发出去的那部分，看不到 CodeBuddy 进程里的工具
* 定义、系统提示词和技能——对这条路由会严重偏低。
*
* 所以把每轮的分类压成一行推理文本：数字是 CodeBuddy 亲口报的，不是估算。放在推理
* 块里不打断正文，展开「思考过程」就能看到；客户端要画圆环也可以直接解析这一行。
*/
function* contextReport(binding, index) {
	const byCategory = binding.breakdown;
	if (byCategory === void 0) return;
	const parts = CONTEXT_CATEGORIES.map(([key, label]) => [label, byCategory[key] ?? 0]).filter(([, value]) => value > 0);
	const total = parts.reduce((sum, [, value]) => sum + value, 0);
	if (total === 0) return;
	const size = binding.contextSize;
	const share = size === void 0 || size <= 0 ? "" : `（${(total / size * 100).toFixed(1)}%）`;
	const window = size === void 0 ? "" : ` / ${formatTokens(size)}`;
	const body = parts.map(([label, value]) => `${label} ${formatTokens(value)}`).join(" · ");
	const text = `上下文 ${formatTokens(total)}${window}${share}｜${body}`;
	yield {
		type: "block-start",
		index,
		blockType: "reasoning"
	};
	yield {
		type: "reasoning-delta",
		index,
		text
	};
	yield {
		type: "block-end",
		index,
		block: {
			type: "reasoning",
			text
		}
	};
}
var AcpAdapter = class extends LlmAdapter {
	agents = /* @__PURE__ */ new Map();
	bindings = /* @__PURE__ */ new Map();
	turns = /* @__PURE__ */ new Map();
	retryPolicy = resolveRetryPolicy(NO_RETRY, `${PLUGIN_ID}: retryPolicy`);
	constructor(host, profiles, contextWindows = new ContextWindows(), capabilities = new PromptCapabilitiesCache(), traceFile = void 0) {
		super();
		this.host = host;
		this.profiles = profiles;
		this.contextWindows = contextWindows;
		this.capabilities = capabilities;
		this.traceFile = traceFile;
	}
	sync() {
		const profiles = this.profiles();
		for (const [route, entry] of this.agents) {
			const profile = profiles.get(route);
			if (profile !== void 0 && spawnFacts(profile) === entry.facts) continue;
			entry.process.dispose();
			this.agents.delete(route);
			this.dropBindings(route);
		}
	}
	dispose() {
		for (const entry of this.agents.values()) entry.process.dispose();
		this.agents.clear();
		this.bindings.clear();
		this.turns.clear();
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: this.profiles().get(provider)?.displayName ?? provider
		};
	}
	providerRetryPolicy() {
		return this.retryPolicy;
	}
	async listModels(provider) {
		const profile = this.profiles().get(provider);
		if (profile === void 0) return [];
		const fallback = () => ({
			provider,
			id: DEFAULT_MODEL_ID,
			name: `${profile.displayName ?? provider} (default)`,
			...this.modalities(provider)
		});
		if (profile.models.length > 0) return profile.models.map((model) => ({
			provider,
			id: model.id,
			name: model.name ?? model.id,
			...model.description === void 0 ? {} : { description: model.description },
			...this.modalities(provider)
		}));
		if (!profile.discoverModels) return [fallback()];
		try {
			const found = await this.advertisedModels(provider);
			if (found.length === 0) return [fallback()];
			return [fallback(), ...found.map((model) => ({
				provider,
				id: model.id,
				name: model.name,
				...model.description === void 0 ? {} : { description: model.description },
				...this.modalities(provider)
			}))];
		} catch (error) {
			this.host.logger.warn(`${PLUGIN_ID}: model discovery for ACP agent "${provider}" failed`, error);
			return [fallback()];
		}
	}
	/**
	* Ask the agent behind one configured route which models it advertises, regardless of
	* the profile's declared `models` and `discoverModels` switch. Settings surfaces use this
	* to offer the agent's own list for adoption.
	*/
	async advertisedModels(provider, signal) {
		const profile = this.profiles().get(provider);
		if (profile === void 0) throw new LlmError(`${PLUGIN_ID}: no ACP agent is configured for provider "${provider}"`, "PROVIDER_NOT_FOUND");
		return this.agent(provider, profile).discoverModels(profile.cwd ?? homedir(), signal);
	}
	/**
	* Exact-model metadata. Capabilities come from the agent itself: accepted input from the
	* `promptCapabilities` of its ACP handshake (learned here, remembered across restarts),
	* reasoning efforts from its `thought_level` option, and the context window it last
	* reported through `usage_update`, else one a "1m" token in the model's id, name or
	* description implies.
	*/
	async resolveModel(provider, model, signal) {
		const profile = this.profiles().get(provider);
		await this.learnCapabilities(provider, signal);
		if (profile?.discoverModels === true && this.agents.get(provider)?.process.advertisedModels === void 0) await this.advertisedModels(provider, signal).catch((error) => {
			this.host.logger.warn(`${PLUGIN_ID}: probing ACP agent "${provider}" for model metadata failed`, error);
		});
		const process = this.agents.get(provider)?.process;
		const configured = profile?.models.find((entry) => entry.id === model);
		const advertised = process?.advertisedModels?.find((entry) => entry.id === model);
		const efforts = process?.advertisedEfforts;
		return {
			provider,
			id: model,
			name: configured?.name ?? advertised?.name ?? model,
			...this.modalities(provider),
			context: { contextWindow: configured?.contextWindow ?? this.contextWindows.get(provider, model) ?? inferContextWindow(model, configured?.name, configured?.description, advertised?.name, advertised?.description) ?? profile?.contextWindow ?? 2e5 },
			...efforts === void 0 ? {} : { reasoning: {
				efforts: efforts.available.map((level) => ({
					id: level.id,
					name: level.name,
					...level.description === void 0 ? {} : { description: level.description }
				})),
				...efforts.available.some((level) => level.id === efforts.initial) ? { defaultEffort: efforts.initial } : {}
			} }
		};
	}
	/**
	* What the route accepts as input. dsh reads an omitted `inputModalities` as "unknown" and
	* sends images through untouched, while an explicit list without `image` is a negative it
	* acts on by replacing every attachment with text before the adapter is even called. So an
	* agent whose handshake nobody has heard yet must stay silent rather than claim text only.
	*/
	modalities(provider) {
		const mode = this.profiles().get(provider)?.imageInput ?? "auto";
		if (mode === "off" || this.host.readImage === void 0) return { inputModalities: TEXT_ONLY };
		if (mode === "force") return { inputModalities: TEXT_AND_IMAGE };
		const known = this.promptCapabilitiesOf(provider);
		if (known === void 0) return {};
		return { inputModalities: known.image ? TEXT_AND_IMAGE : TEXT_ONLY };
	}
	/** The running agent's handshake answer, else the one it gave for these spawn facts before. */
	promptCapabilitiesOf(provider) {
		const live = this.agents.get(provider)?.process.promptCapabilities;
		if (live !== void 0) return live;
		const profile = this.profiles().get(provider);
		return profile === void 0 ? void 0 : this.capabilities.get(provider, spawnFacts(profile));
	}
	/**
	* Make sure the ACP handshake has happened at least once, since that is where an agent
	* states the content types it accepts. The answer is cached per route, so this starts an
	* agent only the first time dsh asks about a route it has never heard from.
	*/
	async learnCapabilities(provider, signal) {
		const profile = this.profiles().get(provider);
		if (profile === void 0 || (profile.imageInput ?? "auto") !== "auto" || this.host.readImage === void 0) return;
		if (this.promptCapabilitiesOf(provider) !== void 0) return;
		await this.agent(provider, profile).probeCapabilities(signal).catch((error) => {
			this.host.logger.warn(`${PLUGIN_ID}: asking ACP agent "${provider}" which content it accepts failed`, error);
		});
	}
	/** Read every image the prompt wants, as base64 request versions; unreadable ones stay text. */
	async readImages(wanted, signal) {
		const read = /* @__PURE__ */ new Map();
		const readImage = this.host.readImage;
		if (readImage === void 0) return read;
		await Promise.all([...wanted].map(async ([id, ref]) => {
			try {
				const image = await readImage(ref, signal);
				read.set(id, {
					data: Buffer.from(image.data).toString("base64"),
					mimeType: image.mediaType,
					width: image.width,
					height: image.height
				});
			} catch (error) {
				this.host.logger.warn(`${PLUGIN_ID}: could not read image attachment ${id}; sending its text handle instead`, error);
			}
		}));
		return read;
	}
	async *stream(options) {
		let finished = false;
		try {
			for await (const chunk of this.run(options)) {
				finished ||= chunk.type === "finish";
				yield chunk;
			}
		} catch (error) {
			if (finished) throw error;
			yield {
				type: "finish",
				reason: options.signal?.aborted ? {
					kind: "aborted",
					failure: failure("ABORTED", "request aborted")
				} : {
					kind: "error",
					failure: failureOf(error)
				}
			};
		}
	}
	async *run(options) {
		const route = options.provider;
		const startedAt = Date.now();
		const profile = this.profiles().get(route);
		if (profile === void 0) throw new LlmError(`${PLUGIN_ID}: no ACP agent is configured for provider "${route}"`, "PROVIDER_NOT_FOUND");
		const signal = options.signal;
		if (signal?.aborted) {
			yield {
				type: "finish",
				reason: {
					kind: "aborted",
					failure: failure("ABORTED", "request aborted before start")
				}
			};
			return;
		}
		const agent = this.agent(route, profile);
		const purpose = Reflect.get(options, "purpose");
		const dshSessionId = options.sessionId;
		const ephemeral = dshSessionId === void 0 || purpose !== void 0;
		const key = `${route}\u0000${dshSessionId ?? ""}`;
		const cwd = this.cwdOf(dshSessionId, profile);
		const conversation = conversationOf(options);
		const system = profile.systemPrompt === "forward" ? systemText(options) : void 0;
		const effort = options.reasoningEffort;
		const trace = new TurnTrace(this.traceFile);
		let images = {
			read: /* @__PURE__ */ new Map(),
			wanted: /* @__PURE__ */ new Map()
		};
		let binding = ephemeral ? void 0 : this.bindings.get(key);
		let reused = binding !== void 0 && binding.session.generation === agent.generation && binding.cwd === cwd && binding.model === options.model;
		const consumedBefore = reused ? binding.consumed : [];
		let prompt = reused ? incrementalPrompt(conversation, consumedBefore, route, images) : void 0;
		if (prompt === void 0 || binding === void 0) {
			reused = false;
			if (binding !== void 0) agent.closeSession(binding.session);
			trace.stage("session");
			const session = await this.guard(route, "session", agent.newSession(cwd, signal), profile.startupTimeoutMs);
			trace.stage("select-model");
			await this.guard(route, "select-model", agent.selectModel(session, options.model, signal), STAGE_TIMEOUT_MS);
			binding = {
				session,
				cwd,
				model: options.model,
				consumed: [],
				usage: void 0
			};
			images = {
				read: /* @__PURE__ */ new Map(),
				wanted: /* @__PURE__ */ new Map()
			};
			prompt = fullPrompt(conversation, system, images);
		}
		trace.start({
			route,
			model: options.model,
			dshSession: dshSessionId,
			ephemeral,
			reused,
			promptBlocks: prompt.length,
			promptChars: prompt.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 0), 0),
			head: promptHead(prompt)
		});
		const wantedEffort = effort ?? binding.session.efforts?.initial;
		if (wantedEffort !== void 0) {
			trace.stage("select-effort");
			await this.guard(route, "select-effort", agent.selectEffort(binding.session, wantedEffort, signal), STAGE_TIMEOUT_MS);
		}
		if (images.wanted.size > 0 && agent.supportsImages) {
			trace.stage("images");
			images = {
				read: await this.readImages(images.wanted, signal),
				wanted: /* @__PURE__ */ new Map()
			};
			prompt = reused ? incrementalPrompt(conversation, consumedBefore, route, images) ?? prompt : fullPrompt(conversation, system, images);
		}
		if (!ephemeral) this.bindings.set(key, binding);
		binding.consumed = consumedIds(conversation);
		const session = binding.session;
		const translator = new ChunkTranslator(profile.showToolCalls);
		const queue = [];
		let outcome;
		let wake;
		const notify = () => {
			wake?.();
			wake = void 0;
		};
		const settle = (next) => {
			outcome ??= next;
			notify();
		};
		let idleTimer;
		const armIdle = () => {
			if (profile.idleTimeoutMs <= 0) return;
			clearTimeout(idleTimer);
			idleTimer = setTimeout(() => {
				agent.cancel(session);
				settle({ kind: "timeout" });
			}, profile.idleTimeoutMs);
		};
		let cancelTimer;
		const onAbort = () => {
			agent.cancel(session);
			cancelTimer = setTimeout(() => settle({ kind: "aborted" }), CANCEL_GRACE_MS);
		};
		this.turns.set(session.sessionId, {
			dshSessionId,
			signal
		});
		signal?.addEventListener("abort", onAbort, { once: true });
		armIdle();
		const model = binding.model;
		trace.stage("prompt");
		agent.prompt(session, prompt, (update) => {
			armIdle();
			trace.update(update.sessionUpdate, update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" ? update.content.text : void 0);
			if (update.sessionUpdate === "usage_update" && update.size > 0) {
				this.contextWindows.set(route, model, update.size);
				binding.contextSize = update.size;
				const meta = Reflect.get(update, "_meta");
				const byCategory = typeof meta === "object" && meta !== null ? Reflect.get(meta, "codebuddy.ai/usageByCategory") : void 0;
				if (typeof byCategory === "object" && byCategory !== null) binding.breakdown = byCategory;
			} else if (update.sessionUpdate === "config_option_update") applyConfigOptions(session, update.configOptions);
			queue.push(...translator.push(update));
			notify();
		}).then((response) => settle({
			kind: "response",
			response
		}), (error) => settle({
			kind: "error",
			error
		}));
		try {
			while (true) {
				while (queue.length > 0) yield queue.shift();
				if (outcome !== void 0) break;
				await new Promise((resolve) => {
					wake = resolve;
				});
			}
			trace.stage("drain");
			yield* translator.close();
			yield* this.finish(outcome, translator, binding, ephemeral, signal);
		} finally {
			clearTimeout(idleTimer);
			clearTimeout(cancelTimer);
			signal?.removeEventListener("abort", onAbort);
			this.turns.delete(session.sessionId);
			if (outcome === void 0) agent.cancel(session);
			if (ephemeral) agent.closeSession(session);
			trace.end({
				stopReason: outcome?.kind === "response" ? outcome.response.stopReason : outcome?.kind,
				ms: Date.now() - startedAt
			});
		}
	}
	*finish(outcome, translator, binding, ephemeral, signal) {
		if (outcome.kind === "error") {
			if (signal?.aborted) {
				yield {
					type: "finish",
					reason: {
						kind: "aborted",
						failure: failure("ABORTED", "request aborted")
					}
				};
				return;
			}
			throw outcome.error;
		}
		if (outcome.kind === "timeout") {
			yield {
				type: "finish",
				reason: {
					kind: "error",
					failure: failure("TIMEOUT", `ACP agent was idle for longer than the configured idleTimeoutMs`)
				}
			};
			return;
		}
		if (outcome.kind === "aborted") {
			yield {
				type: "finish",
				reason: {
					kind: "aborted",
					failure: failure("ABORTED", "request aborted")
				}
			};
			return;
		}
		const { response } = outcome;
		if (response.usage != null) {
			yield {
				type: "usage",
				usage: usageDelta(response.usage, ephemeral ? void 0 : binding.usage)
			};
			binding.usage = response.usage;
		}
		switch (response.stopReason) {
			case "end_turn":
				if (translator.emittedBlocks === 0) {
					yield {
						type: "finish",
						reason: {
							kind: "error",
							failure: failure("EMPTY_RESPONSE", "ACP agent ended the turn without any content")
						}
					};
					return;
				}
				yield* contextReport(binding, translator.emittedBlocks);
				yield {
					type: "finish",
					reason: { kind: "stop" }
				};
				return;
			case "max_tokens":
				yield {
					type: "finish",
					reason: { kind: "max-tokens" }
				};
				return;
			case "cancelled":
				yield {
					type: "finish",
					reason: {
						kind: "aborted",
						failure: failure("ABORTED", "ACP agent cancelled the turn")
					}
				};
				return;
			case "refusal":
				yield {
					type: "finish",
					reason: {
						kind: "error",
						failure: failure("REFUSAL", "ACP agent refused the request")
					}
				};
				return;
			default: yield {
				type: "finish",
				reason: {
					kind: "error",
					failure: failure("MAX_TURN_REQUESTS", `ACP agent stopped: ${response.stopReason}`)
				}
			};
		}
	}
	agent(route, profile) {
		const existing = this.agents.get(route);
		if (existing !== void 0) return existing.process;
		const process = new AcpAgentProcess({
			route,
			profile: () => this.profiles().get(route) ?? profile,
			logger: this.host.logger,
			onCapabilities: (capabilities) => this.capabilities.set(route, this.agents.get(route)?.facts ?? spawnFacts(profile), capabilities),
			onPermission: (sessionId, request) => decidePermission(this.host, route, (this.profiles().get(route) ?? profile).permission, this.turns.get(sessionId), request)
		});
		this.agents.set(route, {
			process,
			facts: spawnFacts(profile)
		});
		return process;
	}
	/**
	* 等一个提问前的请求，但不等到底。
	*
	* Agent 收下请求却不回应时，界面上只会一直转圈、插件停在某个 await 上，既没有异常也没有
	* 日志。这里给个上限，让它变成一条点名到阶段的错误；同时把这个子进程重启掉——一个请求
	* 已经半开着的连接，后面的回合也不会再用得顺。
	*/
	async guard(route, stage, action, ms) {
		let timer;
		const timeout = new Promise((_, reject) => {
			timer = setTimeout(() => {
				this.host.logger.warn(`${PLUGIN_ID}: ACP agent "${route}" accepted ${stage} but did not answer within ${ms}ms; restarting it`);
				this.agents.get(route)?.process.restart();
				this.dropBindings(route);
				reject(new LlmError(`${PLUGIN_ID}: ACP agent "${route}" accepted ${stage} but did not answer within ${ms}ms`, "TRANSPORT"));
			}, ms);
		});
		action.catch(() => {});
		try {
			return await Promise.race([action, timeout]);
		} finally {
			clearTimeout(timer);
		}
	}
	cwdOf(dshSessionId, profile) {
		return (dshSessionId === void 0 ? void 0 : this.host.agentOf(dshSessionId)?.session.header.cwd) ?? profile.cwd ?? homedir();
	}
	dropBindings(route) {
		for (const key of this.bindings.keys()) if (key.startsWith(`${route}\u0000`)) this.bindings.delete(key);
	}
};
//#endregion
//#region src/host/service/request-image.ts
/**
* Aspect-preserving integer dimensions inside a total-pixel budget: rounded inward, never
* enlarging. Same geometry `@deepseek-ai/dsh-attachment` applies, reproduced here because the
* host supplies that package at runtime and this plugin bundles none of it.
*/
function requestImageDimensions(width, height, maxPixels) {
	const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)));
	if (scale === 1) return {
		width,
		height
	};
	if (width >= height) {
		let projectedWidth = Math.max(1, Math.floor(width * scale));
		let projectedHeight = Math.max(1, Math.round(projectedWidth * height / width));
		while (projectedWidth * projectedHeight > maxPixels && projectedWidth > 1) {
			projectedWidth -= 1;
			projectedHeight = Math.max(1, Math.round(projectedWidth * height / width));
		}
		return {
			width: projectedWidth,
			height: projectedHeight
		};
	}
	let projectedHeight = Math.max(1, Math.floor(height * scale));
	let projectedWidth = Math.max(1, Math.round(projectedHeight * width / height));
	while (projectedWidth * projectedHeight > maxPixels && projectedHeight > 1) {
		projectedHeight -= 1;
		projectedWidth = Math.max(1, Math.round(projectedHeight * width / height));
	}
	return {
		width: projectedWidth,
		height: projectedHeight
	};
}
function sideOf(ref, side) {
	const value = ref[side];
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new Error(`${PLUGIN_ID}: image attachment has no usable ${side}; cannot size its request version`);
	return value;
}
/** The request target for one durable image reference, which carries the source dimensions. */
function requestImageTarget(ref, budget) {
	if (typeof ref !== "object" || ref === null) throw new Error(`${PLUGIN_ID}: image attachment reference is not an object`);
	const source = ref;
	return {
		...requestImageDimensions(sideOf(source, "width"), sideOf(source, "height"), budget.maxPixels),
		maxBytes: budget.maxBytes
	};
}
//#endregion
//#region src/host/apply.ts
/** Where this plugin's learned facts persist: `$DSH_HOME` (default `~/.dsh`), as dsh resolves it. */
function cacheFile(name) {
	const configured = process.env.DSH_HOME?.trim();
	return join(resolve(configured === void 0 || configured.length === 0 ? join(homedir(), ".dsh") : configured === "~" || configured.startsWith("~/") ? join(homedir(), configured.slice(1)) : configured), "cache", PLUGIN_ID, name);
}
/** Same request-image budget dsh-llm-pi-ai uses by default. */
const IMAGE_BUDGET = {
	maxPixels: 4194304,
	maxBytes: 1048576
};
function assertProfiles(config) {
	for (const [route, profile] of Object.entries(agentsOf(config))) {
		if (route.trim().length === 0) throw new Error(`${PLUGIN_ID}: agent route names must be non-empty`);
		if (profile.command.trim().length === 0) throw new Error(`${PLUGIN_ID}: agent "${route}" needs a command`);
	}
}
/** The namespace configuration surfaces edit this plugin's profiles under. */
function settingsNsOf(ctx) {
	if (typeof ctx.get("settings")?.installSection === "function") return SETTINGS_NS;
	const entryId = ctx.fiber.entry?.options?.id;
	return typeof entryId === "string" ? entryId : PLUGIN_ID;
}
function directoryEntries(profiles, settingsNs) {
	return [...profiles.entries()].map(([provider, profile]) => ({
		provider,
		displayName: profile.displayName ?? provider,
		settingsNs,
		settingsPath: ["agents", provider],
		declared: true
	}));
}
function routeFacts(profiles, settingsNs) {
	return JSON.stringify([settingsNs, [...profiles.entries()].map(([route, profile]) => [route, profile.displayName ?? null]).sort()]);
}
function apply(ctx, config) {
	assertProfiles(config);
	let current = () => config;
	let lastAgents;
	let memo = /* @__PURE__ */ new Map();
	const profiles = () => {
		const agents = agentsOf(current());
		if (agents !== lastAgents) {
			memo = new Map(Object.entries(agents));
			lastAgents = agents;
		}
		return memo;
	};
	const adapter = new AcpAdapter({
		logger: ctx.logger,
		agentOf: (sessionId) => ctx.get("agents")?.get(sessionId),
		get approve() {
			const approval = ctx.get("approval");
			return approval === void 0 ? void 0 : (request) => approval.request(request);
		},
		get readImage() {
			const attachments = ctx.get("attachments");
			return typeof attachments?.readImageRequest !== "function" ? void 0 : (ref, signal) => attachments.readImageRequest(ref, requestImageTarget(ref, IMAGE_BUDGET), signal);
		}
	}, profiles, new ContextWindows(cacheFile("context-windows.json"), ctx.logger), new PromptCapabilitiesCache(cacheFile("prompt-capabilities.json"), ctx.logger), cacheFile("turns.jsonl"));
	ctx.effect(() => () => adapter.dispose(), `${PLUGIN_ID}: agents`);
	ctx.llm.registerModelDiscovery(SETTINGS_NS, async (request, signal) => {
		const route = request.provider ?? "";
		if (!profiles().has(route)) throw new Error(`${PLUGIN_ID}: save ACP agent "${route}" before discovering its models`);
		return (await adapter.advertisedModels(route, signal)).map((model) => ({
			id: model.id,
			name: model.name
		}));
	});
	let registration;
	let directory;
	let registeredFacts;
	const reconcile = () => {
		adapter.sync();
		const snapshot = profiles();
		const settingsNs = settingsNsOf(ctx);
		const facts = routeFacts(snapshot, settingsNs);
		if (facts === registeredFacts) return;
		const routes = [...snapshot.keys()];
		if (registration === void 0) {
			if (routes.length > 0) registration = ctx.llm.registerAdapter(routes, adapter);
		} else registration.replace(routes);
		const entries = directoryEntries(snapshot, settingsNs);
		if (directory === void 0) {
			if (entries.length > 0) directory = ctx.llm.registerConfigurableProviders(entries);
		} else directory.replace(entries);
		registeredFacts = facts;
	};
	const safeReconcile = () => {
		try {
			reconcile();
		} catch (error) {
			ctx.logger.error(`${PLUGIN_ID}: keeping the previously registered ACP routes after a refused update`, error);
		}
	};
	reconcile();
	ctx.on("loader/volatile-update", safeReconcile);
	ctx.inject(["settings"], (settingsCtx) => {
		const settings = settingsCtx.get("settings");
		if (typeof settings.installSection !== "function") {
			if (typeof settings.configure === "function") settingsCtx.effect(() => settings.configure({ auto: false }, ctx.fiber));
			safeReconcile();
			return;
		}
		settings.installSection(ctx, SETTINGS_NS, Config, config, {
			validate: assertProfiles,
			setSource: (source) => {
				current = source;
			},
			onChange: safeReconcile
		});
	});
}
//#endregion
//#region src/index.ts
const name = PLUGIN_ID;
const inject = ["llm"];
//#endregion
export { AcpAdapter, Config, apply, inject, name };
