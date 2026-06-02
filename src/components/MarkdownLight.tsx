/**
 * MarkdownLight — minimal markdown renderer for v1.34.0.1.
 *
 * Handles the subset of markdown the v1.33.1 AI-assist polish produces:
 *   - **bold** inline
 *   - "- bullet" lines (consecutive ones grouped into a list)
 *   - blank line = paragraph break
 *
 * Not a full markdown library — deliberately tiny so the Wishlist
 * description field renders Karen's polished spec cleanly without
 * pulling in react-markdown / remark-* dependencies for one use site.
 *
 * If the input has no markdown markers, it falls through as plain
 * paragraphs with preserved whitespace. Safe to use on free-text
 * descriptions too.
 */

import type { ReactNode } from "react";

function renderInline(text: string): ReactNode {
  // Split by **bold** markers, keeping the delimiters in the array
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    return <span key={i}>{part}</span>;
  });
}

export function MarkdownLight({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  // Split into blocks by blank lines (allowing for whitespace-only lines)
  const blocks = text.split(/\n\s*\n/).filter((b) => b.trim().length > 0);
  return (
    <div className={className}>
      {blocks.map((block, i) => {
        const lines = block.split("\n");
        // Bullet list block — every non-empty line starts with "- "
        const isBulletList =
          lines.length > 0 &&
          lines
            .filter((l) => l.trim().length > 0)
            .every((l) => l.trim().startsWith("- "));
        if (isBulletList) {
          const items = lines
            .filter((l) => l.trim().startsWith("- "))
            .map((l) => l.replace(/^\s*-\s+/, ""));
          return (
            <ul
              key={i}
              className={
                "list-disc list-outside pl-5 space-y-1 " +
                (i > 0 ? "mt-2" : "")
              }
            >
              {items.map((item, j) => (
                <li key={j}>{renderInline(item)}</li>
              ))}
            </ul>
          );
        }
        // Paragraph block — preserve line breaks within paragraph as <br/>
        const lineNodes: ReactNode[] = [];
        lines.forEach((line, j) => {
          if (j > 0) lineNodes.push(<br key={`br-${j}`} />);
          lineNodes.push(<span key={`l-${j}`}>{renderInline(line)}</span>);
        });
        return (
          <p key={i} className={i > 0 ? "mt-2" : undefined}>
            {lineNodes}
          </p>
        );
      })}
    </div>
  );
}
