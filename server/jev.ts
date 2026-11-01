import { z } from "zod";
import type { Candidate, Evaluation } from "../shared/types.js";
import { loadJevPrompts } from "./jev-prompts.js";
const probability = z.number().finite().min(0).max(1);
const score = z.object({
  type: z.literal("score"),
  score: z.number().finite().min(0).max(4),
  confidence: probability,
});
const evaluation = z.object({
  answers: z.object({
    safety: z.object({ type: z.literal("noul"), noul: probability }),
    relevance: z.object({ type: z.literal("noul"), noul: probability }),
    simplicity: score,
    clarity: score,
    creativity: score,
    visual: score,
  }),
});
export interface Judge {
  // Optional rubric updates occur only at a collection boundary.
  setCriteria?(criteria: string): void;
  evaluate(text: string): Promise<Evaluation>;
  choose(candidates: Candidate[]): Promise<string | "WAIT">;
  surprise(): Promise<string>;
}
export class Jev implements Judge {
  private criteria = "";
  private prompts = loadJevPrompts();
  // Operator preferences supplement the mandatory safety and offline rules.
  setCriteria(criteria: string) {
    this.criteria = criteria;
  }
  constructor(
    private key: string,
    private request: typeof fetch = fetch,
  ) {}
  private async call(state: unknown, questions: unknown) {
    if (!this.key) throw new Error("TypeSafe API key is missing");
    const response = await this.request(
      "https://api.typesafe.ai/v1/systemone",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "jev-latest",
          state: JSON.stringify(state),
          questions,
        }),
        signal: AbortSignal.timeout(12000),
      },
    );
    if (!response.ok)
      throw new Error(`Jev request failed (${response.status})`);
    return response.json();
  }
  async evaluate(text: string): Promise<Evaluation> {
    const questions: Record<string, unknown> = {
      safety: { type: "noul", instructions: this.prompts.evaluate.safety },
      relevance: { type: "noul", instructions: this.prompts.evaluate.relevance },
    };
    for (const [dimension, criteria] of Object.entries(this.prompts.evaluate.rubrics))
      questions[dimension] = {
        type: "score",
        instructions: `${this.prompts.evaluate.scoreInstructions.replaceAll("{dimension}", dimension)} Operator preferences: ${this.criteria}`,
        criteria,
      };
    const a = evaluation.parse(
      await this.call({ audienceComment: text }, questions),
    ).answers;
    return {
      safety: a.safety.noul,
      relevance: a.relevance.noul,
      simplicity: a.simplicity.score * 25,
      clarity: a.clarity.score * 25,
      creativity: a.creativity.score * 25,
      visual: a.visual.score * 25,
    };
  }
  async surprise() {
    const answer = z
      .object({
        answers: z.object({
          idea: z.object({
            type: z.literal("text"),
            text: z.string().min(20).max(600),
            confidence: probability,
          }),
        }),
      })
      .parse(
        await this.call(
          { show: "Prompt Arena", audience: "waiting for content" },
          {
            idea: {
              type: "text",
              instructions: this.prompts.surprise,
            },
          },
        ),
      ).answers.idea;
    if (answer.confidence < 0.6)
      throw new Error("Jev would not commit to a surprise task");
    return answer.text;
  }
  async choose(candidates: Candidate[]) {
    if (!candidates.length) return "WAIT";
    // Option criteria act as instructions to the selector, so viewer text must
    // never appear there: options use opaque ids and the numeric score only,
    // and the suggestion text travels solely in the state payload.
    const options = new Map(
      candidates.map((c, index) => [`candidate-${index + 1}`, c]),
    );
    const criteria: Record<string, string> = Object.fromEntries(
      [...options].map(([id, c]) => [
        id,
        `Suggestion ${id} from the state data. Weighted score: ${Number(c.score)}.`,
      ]),
    );
    criteria.WAIT = this.prompts.choose.wait;
    const answer = z
      .object({
        answers: z.object({
          selection: z.object({
            type: z.literal("choice"),
            choice: z.string(),
            confidence: probability,
          }),
        }),
      })
      .parse(
        await this.call(
          {
            candidates: [...options].map(([id, c]) => ({
              id,
              text: c.text,
              score: c.score,
            })),
          },
          {
            selection: {
              type: "choice",
              instructions: `${this.prompts.choose.instructions} ${this.criteria}`,
              criteria,
            },
          },
        ),
      ).answers.selection;
    if (!Object.hasOwn(criteria, answer.choice))
      throw new Error("Jev returned an unknown candidate");
    if (answer.confidence < 0.6 || answer.choice === "WAIT") return "WAIT";
    return options.get(answer.choice)!.id;
  }
}
