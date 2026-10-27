import { useId } from "react";

type BrandMarkProps = {
  className?: string;
};

export function BrandMark({ className = "" }: BrandMarkProps) {
  const id = useId();

  return (
    <svg
      viewBox="0 0 64 64"
      className={`brand-mark ${className}`.trim()}
      aria-hidden="true"
      focusable="false"
      fill="none"
    >
      <defs>
        <linearGradient id={`${id}-glass`} x1="9" y1="5" x2="54" y2="62" gradientUnits="userSpaceOnUse">
          <stop stopColor="#329776" />
          <stop offset="0.46" stopColor="#086044" />
          <stop offset="1" stopColor="#013D2C" />
        </linearGradient>
        <linearGradient id={`${id}-shine`} x1="31" y1="6" x2="31" y2="33" gradientUnits="userSpaceOnUse">
          <stop stopColor="white" stopOpacity="0.34" />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`${id}-edge`} x1="10" y1="6" x2="54" y2="61" gradientUnits="userSpaceOnUse">
          <stop stopColor="#E5FFF3" stopOpacity="0.8" />
          <stop offset="0.5" stopColor="#ABEDCF" stopOpacity="0.12" />
          <stop offset="1" stopColor="#9DE5BF" stopOpacity="0.42" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="19" fill={`url(#${id}-glass)`} />
      <rect x="3.5" y="3.5" width="57" height="57" rx="17.5" stroke={`url(#${id}-edge)`} />
      <path d="M7 22C7 13.7 13.7 7 22 7H42C50.3 7 57 13.7 57 22V24C42 19 25 20 7 30V22Z" fill={`url(#${id}-shine)`} />
      <circle cx="30" cy="29" r="19" stroke="#D0F9E7" strokeOpacity="0.72" strokeWidth="2.25" />
      <path d="M44 43L51 50" stroke="#E9FFF4" strokeWidth="4.5" strokeLinecap="round" />
      <path d="M18 23L23.5 38L30 27L36.5 38L42 23" stroke="#F4FFF9" strokeWidth="4.25" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M15 13.5C18 11.5 20.5 10.5 24 10" stroke="white" strokeOpacity="0.42" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
