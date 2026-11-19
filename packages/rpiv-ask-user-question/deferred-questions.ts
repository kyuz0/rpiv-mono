import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runRpcQuestionnaire } from "./rpc-fallback.ts";
import { buildQuestionnaireResponse } from "./tool/response-envelope.ts";
import type { QuestionParams } from "./tool/types.ts";

const entryType = "rpiv-deferred-question";
const dialogStatus = "rpiv-deferred-question-dialog";

type QuestionEntry =
	| { id: string; kind: "question"; params: QuestionParams }
	| { id: string; kind: "answer"; text: string }
	| { id: string; kind: "delivered" };

function isQuestionEntry(data: unknown): data is QuestionEntry {
	if (typeof data !== "object" || data === null || !("id" in data) || typeof data.id !== "string" || !("kind" in data))
		return false;
	if (data.kind === "question")
		return (
			"params" in data &&
			typeof data.params === "object" &&
			data.params !== null &&
			"questions" in data.params &&
			Array.isArray(data.params.questions)
		);
	if (data.kind === "answer") return "text" in data && typeof data.text === "string";
	return data.kind === "delivered";
}

export function registerDeferredQuestions(pi: ExtensionAPI) {
	const waiting = new Map<string, QuestionParams>();
	const answers = new Map<string, string>();
	const sent = new Set<string>();
	let dialog: AbortController | undefined;
	let generation = 0;

	function record(entry: QuestionEntry) {
		pi.appendEntry(entryType, entry);
	}

	function showCount(ctx: ExtensionContext) {
		const count = waiting.size;
		if (ctx.mode === "tui") ctx.ui.setStatus(entryType, count ? `Questions (${count}) · /questions` : undefined);
	}

	function deliver(id: string, answer: string) {
		if (sent.has(id)) return;
		sent.add(id);
		// Steer at the next tool boundary, or start a turn if the session is idle.
		pi.sendUserMessage(answer, { deliverAs: "steer" });
	}

	async function askNext(ctx: ExtensionContext): Promise<void> {
		const next = waiting.entries().next();
		if (dialog || next.done || !ctx.hasUI) return;
		const [id, params] = next.value;
		const current = new AbortController();
		dialog = current;
		const options = { signal: current.signal };
		const heading = ctx.mode === "rpc" ? `Answer when ready [${id}]\n` : "";
		function requestUi<T>(request: () => Promise<T>): Promise<T> {
			if (current.signal.aborted || ctx.mode !== "rpc") return request();
			ctx.ui.setStatus(dialogStatus, id);
			try {
				return request();
			} finally {
				ctx.ui.setStatus(dialogStatus, undefined);
			}
		}
		let answer: string | undefined;
		try {
			const result = await runRpcQuestionnaire(
				{
					select: (title, choices) => requestUi(() => ctx.ui.select(heading + title, choices, options)),
					input: (title, placeholder) => requestUi(() => ctx.ui.input(heading + title, placeholder, options)),
				},
				params,
			);
			if (current.signal.aborted) return;
			const response = buildQuestionnaireResponse(result, params).content[0].text;
			answer = `Answer to question ${id}\n${response}`;
			record({ id, kind: "answer", text: answer });
			waiting.delete(id);
			answers.set(id, answer);
		} finally {
			if (dialog === current) dialog = undefined;
		}
		if (!answer) return;
		showCount(ctx);
		finishLater(ctx, () => deliver(id, answer));
		if (ctx.mode === "rpc") finishLater(ctx, () => showDialog(ctx));
	}

	function showDialog(ctx: ExtensionContext) {
		void askNext(ctx).catch(() =>
			ctx.ui.notify("Could not open the question. Use /questions to try again.", "error"),
		);
	}

	function finishLater(ctx: ExtensionContext, action: () => void) {
		const activeGeneration = generation;
		setImmediate(() => {
			if (activeGeneration === generation && ctx.hasUI) action();
		});
	}

	function clear() {
		generation++;
		dialog?.abort();
		dialog = undefined;
		waiting.clear();
		answers.clear();
		sent.clear();
	}

	function load(ctx: ExtensionContext) {
		clear();
		if (!ctx.hasUI) return;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== entryType || !isQuestionEntry(entry.data)) continue;
			const data = entry.data;
			if (data.kind === "question") waiting.set(data.id, data.params);
			else if (data.kind === "answer") {
				waiting.delete(data.id);
				answers.set(data.id, data.text);
			} else answers.delete(data.id);
		}
		showCount(ctx);
		if (ctx.mode === "rpc") finishLater(ctx, () => showDialog(ctx));
	}

	pi.on("session_start", (_event, ctx) => load(ctx));
	pi.on("session_tree", (_event, ctx) => load(ctx));
	pi.on("session_shutdown", clear);
	pi.on("agent_start", (_event, ctx) => {
		if (!answers.size) return;
		finishLater(ctx, () => {
			for (const [id, answer] of answers) deliver(id, answer);
		});
	});
	pi.on("agent_settled", (event) => {
		if (event.aborted) sent.clear();
	});
	pi.on("message_end", ({ message }) => {
		if (!answers.size || message.role !== "user") return;
		const content =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((item) => item.type === "text")
						.map((item) => item.text)
						.join("\n");
		for (const [id, answer] of answers) {
			if (answer !== content) continue;
			record({ id, kind: "delivered" });
			answers.delete(id);
			sent.delete(id);
			break;
		}
	});
	pi.registerCommand("questions", {
		description: "Answer pending questions",
		async handler(_args, ctx) {
			if (!waiting.size) ctx.ui.notify("No pending questions.", "info");
			else await askNext(ctx);
		},
	});

	return (params: QuestionParams, ctx: ExtensionContext) => {
		const id = randomUUID();
		record({ id, kind: "question", params });
		waiting.set(id, params);
		showCount(ctx);
		if (ctx.mode === "rpc") finishLater(ctx, () => showDialog(ctx));
		return id;
	};
}
