/**
 * TemplateEditor — WYSIWYG editor for outreach/recruit template bodies (v1.45.0).
 *
 * Replaces the v1.44 raw-HTML <textarea>. Reps see formatted text (bold,
 * italic, links, lists) — no markdown asterisks, no raw <p>/<strong>/<em>
 * tags. Placeholder tokens like [first name] / $[exact figure] / [my
 * commission rate] render as inline chips via a ProseMirror Decoration so
 * they're visually distinct from the rep's own typing.
 *
 * Why Decoration (not custom Node):
 *   - Underlying text stays as the bracketed literal — same shape the server
 *     substitutePlaceholders regex in refill-outreach-send.ts already
 *     consumes. No round-trip serializer needed.
 *   - Reps can still delete a placeholder by selecting it; the chip styling
 *     is presentational.
 *   - Atomic-delete semantics (chips behave as a single token) are a v2
 *     concern. For v1.45.0 the visual distinction is the unlock.
 *
 * Per [[feedback-human-first-design]]: reps see compose-like output instead
 * of [[markup]]. Per [[feedback-ux-standard]]: clean toolbar, no surprise
 * formatting bloat. Per [[feedback-math-must-be-exact]]: placeholder chips
 * surface "this is a placeholder, will fill at send" visually so reps don't
 * accidentally type around a token they didn't notice.
 */

import { useEffect } from "react";
import { Editor, EditorContent, useEditor } from "@tiptap/react";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import {
  Bold as BoldIcon,
  Italic as ItalicIcon,
  Link as LinkIcon,
  List as ListIcon,
  ListOrdered as ListOrderedIcon,
  Undo2 as UndoIcon,
} from "lucide-react";

// Matches our existing placeholder vocabulary: [first name], [spa name],
// $[exact figure], [N] weeks, [my commission rate], [from first name], etc.
// Anything in [brackets] (optionally prefixed with $) up to 60 chars.
const PLACEHOLDER_REGEX = /\$?\[[^\[\]\n]{1,60}\]/g;

function buildPlaceholderDecorations(doc: any): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node: any, pos: number) => {
    if (!node.isText) return;
    const text: string = node.text ?? "";
    PLACEHOLDER_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PLACEHOLDER_REGEX.exec(text)) !== null) {
      const from = pos + m.index;
      const to = from + m[0].length;
      decos.push(
        Decoration.inline(from, to, {
          class: "refill-placeholder-chip",
        }),
      );
    }
  });
  return DecorationSet.create(doc, decos);
}

const PlaceholderChips = Extension.create({
  name: "placeholderChips",
  addProseMirrorPlugins() {
    const key = new PluginKey("placeholderChips");
    return [
      new Plugin({
        key,
        state: {
          init: (_config, instance) => buildPlaceholderDecorations(instance.doc),
          apply: (tr, oldState) =>
            tr.docChanged ? buildPlaceholderDecorations(tr.doc) : oldState,
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
        },
      }),
    ];
  },
});

interface TemplateEditorProps {
  value: string;
  onChange: (html: string) => void;
  placeholderHints?: readonly string[];
  rows?: number;
  ariaLabel?: string;
}

export function TemplateEditor({
  value,
  onChange,
  placeholderHints,
  rows = 10,
  ariaLabel,
}: TemplateEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Drop heading levels we don't want in an email body; keep H2/H3 for
        // structured templates that use them.
        heading: { levels: [2, 3] },
        // Disable code-block — not useful for email outreach + adds toolbar surface.
        codeBlock: false,
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: {
          class: "refill-editor-link",
          rel: "noopener noreferrer",
          target: "_blank",
        },
      }),
      PlaceholderChips,
    ],
    content: value,
    editorProps: {
      attributes: {
        class: "refill-editor-content",
        // Min-height approximates the textarea rows; tiptap auto-grows past it.
        style: `min-height: ${rows * 1.55}em;`,
        ...(ariaLabel ? { "aria-label": ariaLabel } : {}),
      },
    },
    // Keep content controlled externally. Avoid SSR hydration warnings —
    // editor mounts on client only inside this component.
    immediatelyRender: false,
    onUpdate: ({ editor: ed }) => {
      const html = ed.getHTML();
      onChange(html);
    },
  });

  // External value changes (e.g. template selection swap, Reset to default)
  // need to sync into the editor without re-creating it. setContent w/o
  // emitUpdate to avoid an onChange feedback loop.
  useEffect(() => {
    if (!editor) return;
    if (editor.getHTML() === value) return;
    editor.commands.setContent(value, { emitUpdate: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, editor]);

  return (
    <div className="refill-editor-shell">
      {/* Scoped styles for the editor. Inlined since the rest of the app
          uses inline-style + Tailwind; avoids the cost of touching the
          global CSS just for this component. */}
      <style>{EDITOR_CSS}</style>
      <Toolbar editor={editor} />
      <EditorContent editor={editor} />
      {placeholderHints && placeholderHints.length > 0 && (
        <p
          className="refill-editor-hint"
          style={{ color: "#8a9098", fontSize: 11, marginTop: 6 }}
        >
          Placeholders:{" "}
          {placeholderHints.map((p, i) => (
            <span key={p}>
              <code
                style={{
                  background: "#fdf6e6",
                  color: "#8a6d10",
                  borderRadius: 4,
                  padding: "1px 5px",
                  fontSize: 10.5,
                  fontFamily:
                    'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                }}
              >
                {p}
              </code>
              {i < placeholderHints.length - 1 ? " " : ""}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor | null }) {
  if (!editor) return null;
  return (
    <div
      className="refill-editor-toolbar"
      role="toolbar"
      aria-label="Formatting"
    >
      <ToolButton
        active={editor.isActive("bold")}
        onClick={() => editor.chain().focus().toggleBold().run()}
        label="Bold"
      >
        <BoldIcon className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton
        active={editor.isActive("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        label="Italic"
      >
        <ItalicIcon className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton
        active={editor.isActive("link")}
        onClick={() => promptLink(editor)}
        label="Link"
      >
        <LinkIcon className="h-3.5 w-3.5" />
      </ToolButton>
      <div className="refill-editor-toolbar-divider" aria-hidden />
      <ToolButton
        active={editor.isActive("bulletList")}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        label="Bulleted list"
      >
        <ListIcon className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton
        active={editor.isActive("orderedList")}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        label="Numbered list"
      >
        <ListOrderedIcon className="h-3.5 w-3.5" />
      </ToolButton>
      <div className="refill-editor-toolbar-divider" aria-hidden />
      <ToolButton
        active={false}
        disabled={!editor.can().undo()}
        onClick={() => editor.chain().focus().undo().run()}
        label="Undo"
      >
        <UndoIcon className="h-3.5 w-3.5" />
      </ToolButton>
    </div>
  );
}

function ToolButton({
  active,
  disabled,
  onClick,
  label,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className="refill-editor-toolbtn"
      data-active={active ? "true" : "false"}
    >
      {children}
    </button>
  );
}

function promptLink(editor: Editor) {
  const existing = editor.getAttributes("link").href ?? "";
  // Browser prompt is the lightest-weight link UX for v1; can upgrade to a
  // popover later if reps complain. Empty input removes the link.
  const url = window.prompt("Link URL (leave empty to remove)", existing);
  if (url === null) return; // user cancelled
  if (url === "") {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    return;
  }
  // Light validation — accept http(s)://, mailto:, tel:, or relative paths
  const safe = /^(https?:\/\/|mailto:|tel:|\/)/i.test(url)
    ? url
    : `https://${url}`;
  editor
    .chain()
    .focus()
    .extendMarkRange("link")
    .setLink({ href: safe })
    .run();
}

// All editor styles live here so the component is self-contained. Light
// background mode per [[feedback-light-bg-docs]]; spacing/sizing matches the
// project's existing input shells.
const EDITOR_CSS = `
.refill-editor-shell {
  border: 1px solid #e6e2d6;
  border-radius: 8px;
  background: #fff;
  overflow: hidden;
}
.refill-editor-toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 6px;
  background: #fbfaf7;
  border-bottom: 1px solid #f0ebe0;
}
.refill-editor-toolbar-divider {
  width: 1px;
  height: 16px;
  background: #e6e2d6;
  margin: 0 4px;
}
.refill-editor-toolbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 26px;
  width: 26px;
  border-radius: 5px;
  color: #5a6068;
  background: transparent;
  border: 0;
  cursor: pointer;
  transition: background 80ms ease, color 80ms ease;
}
.refill-editor-toolbtn:hover:not(:disabled) {
  background: #f0ebe0;
  color: #1c2024;
}
.refill-editor-toolbtn[data-active="true"] {
  background: #e8f3ed;
  color: #056048;
}
.refill-editor-toolbtn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.refill-editor-content {
  padding: 10px 12px;
  font-size: 13.5px;
  line-height: 1.55;
  color: #1c2024;
  outline: none;
}
.refill-editor-content:focus-visible {
  outline: none;
}
.refill-editor-content p {
  margin: 0 0 0.6em 0;
}
.refill-editor-content p:last-child {
  margin-bottom: 0;
}
.refill-editor-content h2 {
  font-size: 17px;
  font-weight: 600;
  margin: 0.6em 0 0.3em 0;
  color: #1c2024;
}
.refill-editor-content h3 {
  font-size: 14.5px;
  font-weight: 600;
  margin: 0.5em 0 0.3em 0;
  color: #1c2024;
}
.refill-editor-content ul,
.refill-editor-content ol {
  margin: 0.4em 0 0.6em 0;
  padding-left: 1.4em;
}
.refill-editor-content li {
  margin: 0.15em 0;
}
.refill-editor-content blockquote {
  border-left: 3px solid #cfe4d8;
  padding-left: 12px;
  color: #5a6068;
  margin: 0.6em 0;
}
.refill-editor-content strong {
  font-weight: 600;
  color: #1c2024;
}
.refill-editor-content a,
.refill-editor-content .refill-editor-link {
  color: #056048;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.refill-editor-content code {
  background: #f0ebe0;
  border-radius: 3px;
  padding: 0 4px;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.refill-placeholder-chip {
  background: #fdf6e6;
  color: #8a6d10;
  border-radius: 4px;
  padding: 1px 4px;
  font-size: 0.92em;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: nowrap;
}
.refill-editor-content .ProseMirror {
  outline: none;
  min-height: 9em;
}
.refill-editor-content p.is-editor-empty:first-child::before {
  color: #b8bcc4;
  content: attr(data-placeholder);
  float: left;
  height: 0;
  pointer-events: none;
}
`;
