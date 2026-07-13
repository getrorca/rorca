declare module "@mariozechner/pi-coding-agent" {
  export class Theme {
    fg(kind: string, value: string): string;
    strikethrough(value: string): string;
  }

  export interface ExtensionUi {
    notify(message: string, level?: "info" | "success" | "warning" | "error"): void;
    setStatus(key: string, value?: string): void;
    setWidget(key: string, value?: string[]): void;
    custom<T>(factory: (tui: import("@mariozechner/pi-tui").TUI, theme: Theme, keybindings: unknown, done: (result: T) => void) => import("@mariozechner/pi-tui").Component | Promise<import("@mariozechner/pi-tui").Component>, options?: Record<string, unknown>): Promise<T>;
    select(title: string, options: string[], config?: Record<string, unknown>): Promise<string | undefined>;
    confirm(title: string, message: string): Promise<boolean>;
    theme: {
      fg(kind: string, value: string): string;
      strikethrough(value: string): string;
    };
  }

  export interface ExtensionContext {
    ui: ExtensionUi;
    sessionManager: {
      getEntries(): Array<{ type: string; customType?: string; data?: unknown; message?: any }>;
      getBranch(): Array<{ type: string; customType?: string; data?: unknown; message?: any }>;
    };
    isIdle(): boolean;
  }

  export interface ExtensionAPI {
    on(event: string, handler: (...args: any[]) => unknown): void;
    registerTool(definition: any): void;
    registerCommand(name: string, definition: { description: string; handler: (args: string, ctx: ExtensionContext) => unknown }): void;
    appendEntry(customType: string, data: unknown): void;
    sendUserMessage(content: string | Array<{ type: string; text?: string }>, options?: { deliverAs?: "steer" | "followUp" }): void;
  }
}

declare module "@sinclair/typebox" {
  export const Type: any;
}
