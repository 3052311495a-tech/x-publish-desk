import type { ViewState, WorkspaceLeaf } from 'obsidian';

/** Route file opening before Markdown is created, retaining native leaf/history. */
export class DefaultOpening {
  private enabled = true;
  private queues = new WeakMap<WorkspaceLeaf, Promise<void>>();
  private sourceFiles = new WeakMap<WorkspaceLeaf, string>();
  private original: WorkspaceLeaf['setViewState'];
  private wrapped: WorkspaceLeaf['setViewState'];

  constructor(private prototype: Pick<WorkspaceLeaf, 'setViewState'>, private hooks: {
    owns: (leaf: WorkspaceLeaf) => boolean;
    eligible: (path: string) => boolean;
    deskType: string;
    beforeChange: (leaf: WorkspaceLeaf) => Promise<void>;
  }) {
    this.original = prototype.setViewState;
    const opening = this;
    this.wrapped = function (this: WorkspaceLeaf, state: ViewState, ephemeral?: unknown) {
      if (!opening.enabled || !opening.hooks.owns(this)) return opening.original.call(this, state, ephemeral);
      const previous = opening.queues.get(this) || Promise.resolve();
      const pending = previous.catch(() => {}).then(async () => {
        if (!opening.enabled) return opening.original.call(this, state, ephemeral);
        await opening.hooks.beforeChange(this);
        return opening.original.call(this, opening.route(this, state), ephemeral);
      });
      opening.queues.set(this, pending);
      return pending;
    };
    prototype.setViewState = this.wrapped;
  }

  private route(leaf: WorkspaceLeaf, state: ViewState): ViewState {
    const file = state.state?.file;
    if (typeof file !== 'string') return state;
    if (this.sourceFiles.get(leaf) !== file) this.sourceFiles.delete(leaf);
    if (state.type !== 'markdown' || !this.hooks.eligible(file) || this.sourceFiles.get(leaf) === file) return state;
    return { ...state, type: this.hooks.deskType, state: { file, tab: 'preview' } };
  }

  async openSource(leaf: WorkspaceLeaf, path: string, open: () => Promise<void>): Promise<void> {
    this.sourceFiles.set(leaf, path);
    try { await open(); }
    catch (error) { this.sourceFiles.delete(leaf); throw error; }
  }

  /** A deliberate directory click exits the raw-note exception for that leaf. */
  fromDirectory(leaf: WorkspaceLeaf): void { this.sourceFiles.delete(leaf); }

  dispose(): void {
    this.enabled = false;
    if (this.prototype.setViewState === this.wrapped) this.prototype.setViewState = this.original;
  }
}
