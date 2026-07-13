export const groupedRetryError =
  "You called ask_user_question more than once in the same response while another question is still pending. Retry silently with exactly one native ask_user_question call using {\"questions\":[...]} so all fields render in one card with one submit button. Put every field's options, inputType, dateFormat, dataSource, multiple, required, and default inside its questions[] item. Do not explain this correction to the user.";

export class PendingCallCoordinator {
  private readonly activeToolCalls = new Set<string>();
  private readonly pendingToolCallBySignal = new WeakMap<AbortSignal, string>();

  start(toolCallId: string, signal: AbortSignal | undefined): () => void {
    if (this.activeToolCalls.has(toolCallId)) throw new Error(`Question is already pending: ${toolCallId}`);
    const pendingInCurrentTurn = signal ? this.pendingToolCallBySignal.get(signal) : undefined;
    if (pendingInCurrentTurn && this.activeToolCalls.has(pendingInCurrentTurn)) throw new Error(groupedRetryError);

    this.activeToolCalls.add(toolCallId);
    if (signal) this.pendingToolCallBySignal.set(signal, toolCallId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeToolCalls.delete(toolCallId);
      if (signal && this.pendingToolCallBySignal.get(signal) === toolCallId) this.pendingToolCallBySignal.delete(signal);
    };
  }
}
