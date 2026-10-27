import { Fragment } from "react";

export function HighlightedText({ text, query }: { text: string; query: string }) {
  const words = [...new Set(query.match(/[\p{L}\p{N}]+/gu) ?? [])].filter((word) => word.length > 1);
  if (!words.length) return text;

  const pattern = new RegExp(`(${words.map(escapeRegExp).join("|")})`, "giu");
  return text.split(pattern).map((part, index) =>
    words.some((word) => word.toLocaleLowerCase() === part.toLocaleLowerCase()) ? (
      <mark key={`${part}-${index}`} className="rounded bg-[#d4ebdb]/85 px-0.5 text-inherit box-decoration-clone">
        {part}
      </mark>
    ) : <Fragment key={`${part}-${index}`}>{part}</Fragment>,
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
