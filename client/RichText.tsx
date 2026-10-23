import { t, getLocale, translateSystemMessage } from '../shared/i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import { Bold, Italic, Underline, Strikethrough, List, ListOrdered, Quote, Code, Link, ImagePlus, Undo2, Redo2, Table, X } from 'lucide-react';
import { cleanJournalHtml, journalEditorProblem, safeJournalImage, safeJournalLink } from './journal-html';

export default function RichText({ value, onChange, disabled = false, label = t("Page text"), onBlockedChange }: {
  value: string; onChange: (value: string) => void; disabled?: boolean; label?: string; onBlockedChange?: (problem: string | null) => void;
}) {
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  const blockedCallback = useRef(onBlockedChange); blockedCallback.current = onBlockedChange;
  const locale = getLocale();
  const sourceProblem = useMemo(() => journalEditorProblem(value), [value, locale]);
  const [runtimeProblem, setRuntimeProblem] = useState<string | null>(null), [pasteError, setPasteError] = useState('');
  const problem = sourceProblem || runtimeProblem;
  const blocked = useRef(false); blocked.current = disabled || !!problem;
  const [insert, setInsert] = useState<'link' | 'image' | null>(null), [url, setUrl] = useState(''), [alt, setAlt] = useState(''), [error, setError] = useState('');
  const selection = useRef({ from: 1, to: 1 });
  function rejectHtml(html: string, event: Event): boolean {
    if (blocked.current) { event.preventDefault(); return true; }
    const reason = html && journalEditorProblem(html);
    if (!reason) { setPasteError(''); return false; }
    event.preventDefault(); setPasteError(t("Nothing pasted. {value0}", { value0: reason })); return true;
  }
  const editor = useEditor({
    extensions: [StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] }, link: { openOnClick: false, autolink: false, HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer' } } }), Image.configure({ allowBase64: false }), TableKit.configure({ table: { resizable: false } })],
    content: sourceProblem ? '' : cleanJournalHtml(value), editable: !blocked.current, immediatelyRender: false, shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: { role: 'textbox', 'aria-label': label, 'aria-multiline': 'true' },
      handlePaste: (_view, event) => rejectHtml(event.clipboardData?.getData('text/html') || '', event),
      handleDrop: (_view, event) => rejectHtml(event.dataTransfer?.getData('text/html') || '', event),
      transformPastedHTML: html => journalEditorProblem(html) ? '' : cleanJournalHtml(html),
    },
    onUpdate: ({ editor: current }) => {
      if (blocked.current || current.isDestroyed || !current.schema) return;
      // Tiptap generates table layout styles; they are not part of the server's HTML contract.
      const html = cleanJournalHtml(current.getHTML()), reason = journalEditorProblem(html);
      if (reason) { setRuntimeProblem(reason); return; }
      onChangeRef.current(html);
    },
  });
  useEffect(() => {
    setRuntimeProblem(null);
    if (editor && !editor.isDestroyed && editor.schema && !sourceProblem) {
      const clean = cleanJournalHtml(value);
      if (cleanJournalHtml(editor.getHTML()) !== clean) editor.commands.setContent(clean, { emitUpdate: false });
    }
  }, [value, sourceProblem, editor]);
  useEffect(() => {
    if (editor && !editor.isDestroyed && editor.schema) editor.setEditable(!disabled && !problem, false);
    blockedCallback.current?.(problem);
  }, [disabled, problem, editor]);
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.setOptions({
      editorProps: { ...editor.options.editorProps, attributes: { role: 'textbox', 'aria-label': label, 'aria-multiline': 'true' } },
    });
  }, [editor, label]);
  if (problem) return <div className="rich-editor is-disabled" style={{ padding: '1rem' }}><p role="alert" className="error">{translateSystemMessage(problem)}</p><div className="journal-prose" role="region" aria-label={t("{value0}: read only", { value0: label })} dangerouslySetInnerHTML={{ __html: cleanJournalHtml(value) }}/></div>;
  if (!editor || editor.isDestroyed || !editor.schema) return <p className="muted">{t("Loading editor…")}</p>;
  const tool = (name: string, icon: React.ReactNode, action: () => void, active = false, unavailable = false) => <button type="button" title={name} aria-label={name} aria-pressed={active} disabled={disabled || unavailable} onClick={action}>{icon}</button>;
  function openInsert(kind: 'link' | 'image') { selection.current = { from: editor!.state.selection.from, to: editor!.state.selection.to }; setInsert(kind); setUrl(kind === 'link' ? editor!.getAttributes('link').href || '' : ''); setAlt(''); setError(''); }
  function applyInsert() {
    const safe = insert === 'image' ? safeJournalImage(url) : safeJournalLink(url);
    if (!safe) { setError(insert === 'image' ? t("Enter an http/https image address or /assets/… path.") : t("Enter http/https, mailto or a #… anchor.")); return; }
    const chain = editor!.chain().focus().setTextSelection(selection.current);
    if (insert === 'image') chain.setImage({ src: safe, alt }).run();
    else if (selection.current.from === selection.current.to) chain.insertContent({ type: 'text', text: alt || safe, marks: [{ type: 'link', attrs: { href: safe, target: '_blank', rel: 'noopener noreferrer' } }] }).run();
    else chain.setLink({ href: safe }).run();
    setInsert(null);
  }
  return <div className={`rich-editor ${disabled ? 'is-disabled' : ''}`}>
    <div className="rich-toolbar" role="toolbar" aria-label={t("Text formatting")}>
      <select aria-label={t("Paragraph style")} disabled={disabled} value={[1, 2, 3, 4, 5, 6].find(level => editor.isActive('heading', { level })) || 'p'} onChange={e => e.target.value === 'p' ? editor.chain().focus().setParagraph().run() : editor.chain().focus().toggleHeading({ level: Number(e.target.value) as 1 | 2 | 3 | 4 | 5 | 6 }).run()}><option value="p">{t("Paragraph")}</option>{[1, 2, 3, 4, 5, 6].map(level => <option key={level} value={level}>{t("Heading")} {level}</option>)}</select>
      {tool(t("Bold"), <Bold size={16}/>, () => editor.chain().focus().toggleBold().run(), editor.isActive('bold'))}
      {tool(t("Italic"), <Italic size={16}/>, () => editor.chain().focus().toggleItalic().run(), editor.isActive('italic'))}
      {tool(t("Underline"), <Underline size={16}/>, () => editor.chain().focus().toggleUnderline().run(), editor.isActive('underline'))}
      {tool(t("Strikethrough"), <Strikethrough size={16}/>, () => editor.chain().focus().toggleStrike().run(), editor.isActive('strike'))}
      {tool(t("Bulleted list"), <List size={16}/>, () => editor.chain().focus().toggleBulletList().run(), editor.isActive('bulletList'))}
      {tool(t("Numbered list"), <ListOrdered size={16}/>, () => editor.chain().focus().toggleOrderedList().run(), editor.isActive('orderedList'))}
      {tool(t("Quote"), <Quote size={16}/>, () => editor.chain().focus().toggleBlockquote().run(), editor.isActive('blockquote'))}
      {tool(t("Code block"), <Code size={16}/>, () => editor.chain().focus().toggleCodeBlock().run(), editor.isActive('codeBlock'))}
      {tool(t("Insert link"), <Link size={16}/>, () => openInsert('link'), editor.isActive('link'))}
      {tool(t("Insert image"), <ImagePlus size={16}/>, () => openInsert('image'))}
      {tool(t("Insert table"), <Table size={16}/>, () => editor.chain().focus().insertTable({ rows: 3, cols: 2, withHeaderRow: true }).run())}
      {tool(t("Undo text edit"), <Undo2 size={16}/>, () => editor.chain().focus().undo().run(), false, !editor.can().undo())}
      {tool(t("Redo text edit"), <Redo2 size={16}/>, () => editor.chain().focus().redo().run(), false, !editor.can().redo())}
    </div>
    {insert && <div className="rich-insert"><strong>{insert === 'image' ? t("Image") : t("Link")}</strong><button type="button" aria-label={t("Close insertion")} onClick={() => setInsert(null)}><X size={15}/></button><label className="field stacked"><span>{t("Address")}</span><input autoFocus value={url} onChange={e => setUrl(e.target.value)} maxLength={2048}/></label><label className="field stacked"><span>{insert === 'image' ? t("Image description") : t("New link text")}</span><input value={alt} onChange={e => setAlt(e.target.value)} maxLength={500}/></label>{error && <p role="alert" className="error">{translateSystemMessage(error)}</p>}<button type="button" onClick={applyInsert} disabled={disabled}>{t("Insert")}</button>{insert === 'link' && editor.isActive('link') && <button type="button" onClick={() => { editor.chain().focus().unsetLink().run(); setInsert(null); }}>{t("Remove link")}</button>}</div>}
    {pasteError && <p role="alert" className="error">{translateSystemMessage(pasteError)}</p>}
    <EditorContent editor={editor}/>
    {editor.isActive('table') && <div className="rich-table-actions"><button type="button" disabled={disabled} onClick={() => editor.chain().focus().addRowAfter().run()}>{t("+ row")}</button><button type="button" disabled={disabled} onClick={() => editor.chain().focus().addColumnAfter().run()}>{t("+ column")}</button><button type="button" disabled={disabled} onClick={() => editor.chain().focus().deleteRow().run()}>{t("− row")}</button><button type="button" disabled={disabled} onClick={() => editor.chain().focus().deleteColumn().run()}>{t("− column")}</button><button type="button" disabled={disabled} onClick={() => editor.chain().focus().deleteTable().run()}>{t("Remove table")}</button></div>}
  </div>;
}
