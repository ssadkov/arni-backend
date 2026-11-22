const OPEN = '<thinking>';
const CLOSE = '</thinking>';
const WRAPPERS = ['<answer>', '</answer>'];

/** How much of the end of `text` could be the beginning of one of `tags`, split across stream chunks. */
function partialTag(text: string, tags: readonly string[]): number {
	const longest = Math.min(text.length, Math.max(...tags.map(tag => tag.length)) - 1);
	for (let size = longest; size > 0; size--) {
		if (tags.some(tag => tag.startsWith(text.slice(-size)))) { return size; }
	}
	return 0;
}

/**
 * Nova Lite writes its reasoning into the answer as `<thinking>…</thinking>` (17 of 18 agent tasks on 2026-11-22)
 * and sometimes wraps the answer in `<answer>`. Removes the first, unwraps the second, across stream chunks.
 */
export class InlineThinkingFilter {
	private pending = '';
	private thinking = false;
	private thought = '';
	private visible = false;

	push(chunk: string): string {
		this.pending += chunk;
		let shown = '';
		while (this.pending) {
			if (this.thinking) {
				const end = this.pending.indexOf(CLOSE);
				if (end < 0) {
					const keep = partialTag(this.pending, [CLOSE]);
					this.thought += this.pending.slice(0, this.pending.length - keep);
					this.pending = this.pending.slice(this.pending.length - keep);
					break;
				}
				this.thought += this.pending.slice(0, end);
				this.pending = this.pending.slice(end + CLOSE.length);
				this.thinking = false;
				continue;
			}
			const tags = [OPEN, ...WRAPPERS];
			const next = tags.map(tag => ({ tag, at: this.pending.indexOf(tag) })).filter(found => found.at >= 0).sort((a, b) => a.at - b.at)[0];
			if (!next) {
				const keep = partialTag(this.pending, tags);
				shown += this.pending.slice(0, this.pending.length - keep);
				this.pending = this.pending.slice(this.pending.length - keep);
				break;
			}
			shown += this.pending.slice(0, next.at);
			this.pending = this.pending.slice(next.at + next.tag.length);
			this.thinking = next.tag === OPEN;
		}
		return this.show(shown);
	}

	/**
	 * Flushes the held tail. With no tool call and nothing shown, the thought is all the model said:
	 * return it rather than an empty answer.
	 */
	end(hasToolCall: boolean): string {
		const tail = this.thinking ? '' : this.pending;
		if (this.thinking) { this.thought += this.pending; }
		this.pending = '';
		const shown = this.show(tail);
		return shown || this.visible || hasToolCall ? shown : this.thought.trim();
	}

	/** Drops the blank lines a removed leading block leaves before the answer. */
	private show(text: string): string {
		const shown = this.visible ? text : text.trimStart();
		if (shown) { this.visible = true; }
		return shown;
	}
}
