import {
  MessageProcessor,
  type Catalog,
  type ActionPayload,
} from "@a2ui/web_core/v0_9";
import {
  documentMessages,
  type UiDocument,
  type UiState,
  type UiAction,
} from "./index.js";
export interface UiCallbacks {
  save(states: UiState[], revision: number): Promise<UiDocument>;
  action(input: {
    action: UiAction;
    states: UiState[];
    revision: number;
    request_id: string;
  }): Promise<void>;
  changed?(): void;
}
/** Serialized writes, optimistic revisions, debounced input, and idempotent action retries. */
export class UiSession {
  readonly processor: MessageProcessor<any>;
  document: UiDocument;
  error = "";
  busy = false;
  enabled = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<void> | undefined;
  private dirty = false;
  private applying = false;
  private disposed = false;
  private subscriptions: { unsubscribe(): void }[] = [];
  private baseline = "";
  private pendingAction: { key: string; id: string } | undefined;
  constructor(
    doc: UiDocument,
    catalog: Catalog<any>,
    public callbacks: UiCallbacks,
  ) {
    this.document = doc;
    this.processor = new MessageProcessor([catalog], (a) => this.submit(a));
    this.apply(doc);
  }
  states(): UiState[] {
    return [...this.processor.getSurfaces().values()].map((s) => ({
      surfaceId: s.id,
      data: s.dataModel.get("/"),
    }));
  }
  private apply(doc: UiDocument) {
    this.applying = true;
    try {
      this.subscriptions.forEach((s) => s.unsubscribe());
      this.subscriptions = [];
      const ids = new Set(doc.surfaces.map((s) => s.id));
      for (const id of this.processor.getSurfaces().keys())
        if (!ids.has(id))
          this.processor.processMessages({
            version: "v0.9",
            deleteSurface: { surfaceId: id },
          });
      for (const surface of doc.surfaces) {
        const old = this.processor.getSurface(surface.id);
        const previous = this.document.surfaces.find(
          (s) => s.id === surface.id,
        );
        if (
          old &&
          JSON.stringify(previous?.components) ===
            JSON.stringify(surface.components)
        )
          this.processor.processMessages({
            version: "v0.9",
            updateDataModel: {
              surfaceId: surface.id,
              path: "/",
              value: JSON.parse(JSON.stringify(surface.data)),
            },
          });
        else {
          if (old)
            this.processor.processMessages({
              version: "v0.9",
              deleteSurface: { surfaceId: surface.id },
            });
          this.processor.processMessages(
            documentMessages({ ...doc, surfaces: [surface] }),
          );
        }
      }
      this.document = doc;
      this.baseline = JSON.stringify(this.states());
      for (const s of this.processor.getSurfaces().values()) {
        this.subscriptions.push(
          s.dataModel.subscribe("/", () => this.inputChanged()),
          s.onError.subscribe((e) => {
            this.error = e.message;
            this.callbacks.changed?.();
          }),
        );
      }
    } finally {
      this.applying = false;
    }
  }
  receive(doc: UiDocument) {
    if (doc.revision <= this.document.revision) return;
    if (this.dirty || this.writing) {
      this.error = "界面已在其他设备更新，请点击重新载入";
      this.callbacks.changed?.();
      return;
    }
    this.apply(doc);
    this.callbacks.changed?.();
  }
  reload(doc: UiDocument) {
    clearTimeout(this.timer);
    this.dirty = false;
    this.error = "";
    this.pendingAction = undefined;
    this.apply(doc);
    this.callbacks.changed?.();
  }
  private inputChanged() {
    if (
      this.applying ||
      this.disposed ||
      !this.enabled ||
      JSON.stringify(this.states()) === this.baseline
    )
      return;
    this.dirty = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush().catch(() => {});
    }, 700);
  }
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.writing) {
      await this.writing;
      if (this.dirty) return this.flush();
      return;
    }
    if (!this.dirty) return;
    const states = this.states();
    const snapshot = JSON.stringify(states);
    const revision = this.document.revision;
    this.dirty = false;
    this.writing = (async () => {
      try {
        const doc = await this.callbacks.save(states, revision);
        this.document = doc;
        this.baseline = snapshot;
        this.error = "";
      } catch (e) {
        this.dirty = true;
        this.error = e instanceof Error ? e.message : "保存界面状态失败";
        throw e;
      } finally {
        this.writing = undefined;
        if (!this.disposed) this.callbacks.changed?.();
      }
    })();
    return this.writing;
  }
  async submit(event: ActionPayload) {
    if (!this.enabled || this.busy || this.disposed) return;
    this.busy = true;
    this.error = "";
    this.callbacks.changed?.();
    try {
      await this.flush();
      const action: UiAction = {
        name: event.name,
        surfaceId: event.surfaceId,
        sourceComponentId: event.sourceComponentId,
        context: event.context,
      };
      const states = this.states();
      const key = JSON.stringify({ action, states });
      if (this.pendingAction?.key !== key)
        this.pendingAction = { key, id: crypto.randomUUID() };
      await this.callbacks.action({
        action,
        states,
        revision: this.document.revision,
        request_id: this.pendingAction.id,
      });
      this.pendingAction = undefined;
      this.enabled = false;
    } catch (e) {
      this.error = e instanceof Error ? e.message : "提交界面操作失败";
    } finally {
      this.busy = false;
      if (!this.disposed) this.callbacks.changed?.();
    }
  }
  dispose() {
    clearTimeout(this.timer);
    this.disposed = true;
    // Persist the last edit when leaving the timeline; callbacks carry the original message identity.
    const done = this.flush()
      .catch(() => {})
      .finally(() => {
        this.subscriptions.forEach((s) => s.unsubscribe());
        this.processor.dispose();
      });
    return done;
  }
}
