/**
 * A scripted stand-in for an LLM agent, so the core can be tested without API keys.
 * It behaves the way models typically do when a tool call errors: it tries again
 * (up to `maxAttempts`), then moves on to the next step.
 */
export interface Step {
  call: (...args: any[]) => Promise<unknown>
  args: unknown
}

export async function scriptedAgent(steps: Step[], maxAttempts = 3): Promise<void> {
  for (const step of steps) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await step.call(step.args)
        break
      } catch (e) {
        // A real framework turns the error into a tool-result message and the
        // model decides to retry. Crashes propagate (the process is gone).
        if ((e as { shakedownCrash?: boolean }).shakedownCrash) throw e
        if (attempt === maxAttempts) throw e
      }
    }
  }
}
