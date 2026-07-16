declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionUi {
    notify(message: string, level?: "info" | "success" | "warning" | "error"): void;
    setStatus(key: string, value?: string): void;
    setWidget(key: string, value?: string[]): void;
    select(title: string, options: string[], config?: Record<string, unknown>): Promise<string | undefined>;
    confirm(title: string, message: string): Promise<boolean>;
    custom<T>(
      factory: (tui: any, theme: Theme, keybindings: any, done: (value: T) => void) => any,
      options?: Record<string, unknown>,
    ): Promise<T>;
    theme: {
      fg(kind: string, value: string): string;
      strikethrough(value: string): string;
    };
  }

  export interface Theme {
    fg(kind: string, value: string): string;
    strikethrough(value: string): string;
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
