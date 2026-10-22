import type { ReactNode } from 'react';

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      width="26"
      height="26"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const FeedIcon = () => (
  <Icon>
    <path d="M12 3c3.5 4 5.5 6.8 5.5 9.5a5.5 5.5 0 0 1-11 0C6.5 9.8 8.5 7 12 3Z" />
    <path d="M9.5 13.5a2.6 2.6 0 0 0 2 2.4" />
  </Icon>
);

export const PlayIcon = () => (
  <Icon>
    <path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z" />
    <path d="M19 16.5v4M17 18.5h4" />
  </Icon>
);

export const DecorIcon = () => (
  <Icon>
    <path d="M12 21v-8" />
    <path d="M12 13c0-4-3-6-6-6 0 4 2 6 6 6Z" />
    <path d="M12 15c0-3.5 2.6-5.5 6-5.5 0 3.5-2.4 5.5-6 5.5Z" />
    <path d="M7 21h10" />
  </Icon>
);

export const ShopIcon = () => (
  <Icon>
    <path d="M5 8h14l-1 12H6L5 8Z" />
    <path d="M9 8a3 3 0 0 1 6 0" />
  </Icon>
);

export const CareIcon = () => (
  <Icon>
    <path d="M12 20.5s-7.5-4.4-7.5-10A4.3 4.3 0 0 1 12 8a4.3 4.3 0 0 1 7.5 2.5c0 5.6-7.5 10-7.5 10Z" />
  </Icon>
);

export const TankIcon = () => (
  <Icon>
    <rect x="3" y="5" width="18" height="14" rx="3" />
    <path d="M3 10c3 1.5 5-1.5 9 0s6-1.5 9 0" />
    <circle cx="9" cy="15" r="0.8" fill="currentColor" />
    <circle cx="14" cy="14" r="0.8" fill="currentColor" />
  </Icon>
);

export const BookIcon = () => (
  <Icon>
    <path d="M5 4.5h10.5a3 3 0 0 1 3 3V20H8a3 3 0 0 1-3-3V4.5Z" />
    <path d="M5 17a3 3 0 0 1 3-3h10.5" />
    <path d="M9.5 8.5c1.2-1.2 3-1.2 4 0-1 1.2-2.8 1.2-4 0Z" />
  </Icon>
);

export const PersonIcon = () => (
  <Icon>
    <circle cx="12" cy="8.5" r="3.5" />
    <path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" />
  </Icon>
);

export const SunIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" />
  </Icon>
);

export const AutoLightIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Icon>
);

export const MoonIcon = () => (
  <Icon>
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
  </Icon>
);

export const DuskIcon = () => (
  <Icon>
    <path d="M6 17a6 6 0 0 1 12 0" />
    <path d="M3 17h18M12 5v3M5.6 9.6 7 11M18.4 9.6 17 11" />
  </Icon>
);

export const PhotoIcon = () => (
  <Icon>
    <path d="M4 8h3l1.5-2.5h7L17 8h3v11H4V8Z" />
    <circle cx="12" cy="13.5" r="3.5" />
  </Icon>
);
