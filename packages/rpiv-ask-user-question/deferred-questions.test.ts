import { createMockCtx, createMockPi, makeCustomEntry, makeUserMessage } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";
import { registerAskUserQuestionTool } from "./ask-user-question.ts";
import { makeQuestion } from "./test-fixtures.ts";

describe("deferred questionnaires", () => {
	it("returns before any answer and sends the eventual answer as user input", async () => {
		const { pi, captured } = createMockPi();
		registerAskUserQuestionTool(pi);
		const select = vi.fn<() => Promise<string | undefined>>();
		let answer: (value: string) => void = () => {};
		select.mockImplementation(
			() =>
				new Promise((resolve) => {
					answer = resolve;
				}),
		);
		const ctx = createMockCtx({ hasUI: true, mode: "rpc", ui: { select } });
		const tool = captured.tools.get("ask_user_question")!;
		const result = await tool.execute(
			"call",
			{ questions: [makeQuestion()], waitForAnswer: false },
			undefined,
			undefined,
			ctx,
		);
		expect(result.details).toMatchObject({ status: "pending" });
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
		await vi.waitFor(() =>
			expect(select).toHaveBeenCalledWith(
				expect.stringMatching(/^Answer when ready \[[\da-f-]{36}\]\n/),
				expect.any(Array),
				expect.any(Object),
			),
		);
		answer("2. B — b");
		await vi.waitFor(() =>
			expect(pi.sendUserMessage).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('"Pick one"="B"'), {
				deliverAs: "steer",
			}),
		);
		const delivery = vi.mocked(pi.sendUserMessage).mock.calls[0]?.[0];
		expect(typeof delivery).toBe("string");
		captured.events.get("message_end")?.[0]?.({ message: makeUserMessage(String(delivery)) });
		expect(captured.entries.map((entry) => (entry.data as { kind: string }).kind)).toEqual([
			"question",
			"answer",
			"delivered",
		]);
	});

	it("reopens only unanswered questions in the restored branch", async () => {
		const { pi, captured } = createMockPi();
		registerAskUserQuestionTool(pi);
		const id = "ef956309-a196-4d62-b23a-a67dae1b1940";
		const ctx = createMockCtx({
			hasUI: true,
			mode: "rpc",
			branch: [
				makeCustomEntry("rpiv-deferred-question", {
					id: "closed",
					kind: "question",
					params: { questions: [makeQuestion()] },
				}),
				makeCustomEntry("rpiv-deferred-question", { id: "closed", kind: "answer", text: "prior answer" }),
				makeCustomEntry("rpiv-deferred-question", { id: "closed", kind: "delivered" }),
				makeCustomEntry("rpiv-deferred-question", {
					id,
					kind: "question",
					params: { questions: [makeQuestion()] },
				}),
			],
			ui: { select: vi.fn(() => new Promise<string | undefined>(() => {})) },
		});
		captured.events.get("session_start")?.[0]?.({}, ctx);
		await vi.waitFor(() => expect(ctx.ui.select).toHaveBeenCalledTimes(1));
		expect(ctx.ui.select).toHaveBeenCalledWith(expect.stringContaining(id), expect.any(Array), expect.any(Object));
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
		captured.events.get("session_shutdown")?.[0]?.({});
	});
});
