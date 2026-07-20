interface TelegramWebApp {
  initData: string;
  ready(): void;
  expand(): void;
  close(): void;
  HapticFeedback?: {
    impactOccurred(style: "light" | "medium" | "heavy" | "rigid" | "soft"): void;
    notificationOccurred(type: "error" | "success" | "warning"): void;
  };
}

interface Window {
  Telegram?: {
    WebApp: TelegramWebApp;
  };
}
