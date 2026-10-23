/** Isolated browser-only regression harness. No server, campaign or persistent storage writes. */
import { StrictMode, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import RichText from '../client/RichText';
import { cleanJournalHtml, journalEditorProblem } from '../client/journal-html';

import { setLocale } from '../shared/i18n';
setLocale('en');

const initial = '<p>Visible baseline</p>';
function App() {
  const [value, setValue] = useState(initial), [problem, setProblem] = useState<string | null>(null), [results, setResults] = useState<string[]>([]);
  const [changes, setChanges] = useState(0), changesRef = useRef(0);
  function record(name: string, passed: boolean) { setResults(rows => [...rows, `${passed ? 'PASS' : 'FAIL'} — ${name}`]); }
  function helpers() {
    const rows: [string, boolean][] = [];
    for (const tag of ['sub', 'sup', 'caption', 'thead', 'tfoot']) {
      const html = ['caption', 'thead', 'tfoot'].includes(tag) ? `<table><${tag}>${tag === 'caption' ? 'Caption' : '<tr><td>Cell</td></tr>'}</${tag}></table>` : `<p><${tag}>Text</${tag}></p>`;
      rows.push([`block ${tag}`, !!journalEditorProblem(html)]);
    }
    rows.push(['block heading id', !!journalEditorProblem('<h2 id="jh-link">Title</h2>')]);
    rows.push(['block cell scope', !!journalEditorProblem('<table><tr><th scope="col">Cell</th></tr></table>')]);
    rows.push(['block unsupported style', !!journalEditorProblem('<p style="color:red">Text</p>')]);
    rows.push(['block bad href', !!journalEditorProblem('<p><a href="javascript:alert(1)">Link</a></p>')]);
    rows.push(['allow heading 4–6', !journalEditorProblem('<h4>Four</h4><h5>Five</h5><h6>Six</h6>')]);
    rows.push(['allow link title', !journalEditorProblem('<p><a href="#jh-test" title="Tooltip">Link</a></p>')]);
    rows.push(['allow basic table', !journalEditorProblem('<table><tbody><tr><th colspan="2">Title</th></tr><tr><td>A</td><td>B</td></tr></tbody></table>')]);
    for (const html of ['<section class="secret">PRIVATE</section>', '<div class="note SeCrEt other">PRIVATE</div>', '<p class="se&#99;ret">PRIVATE</p>', '<body class="secret"><p>PRIVATE</p></body>', '<tr class="secret"><td>PRIVATE</td></tr>', '<td title="a > b" class="se&#99;ret">PRIVATE</td>']) {
      rows.push([`raw secret rejected ${rows.length}`, !!journalEditorProblem(html)]);
      rows.push([`secret subtree removed ${rows.length}`, !cleanJournalHtml(html).includes('PRIVATE')]);
    }
    rows.push(['renderer keeps surrounding public text', cleanJournalHtml('<p>PUBLIC</p><section class="secret"><strong>PRIVATE</strong></section>').includes('PUBLIC') && !cleanJournalHtml('<p>PUBLIC</p><section class="secret"><strong>PRIVATE</strong></section>').includes('PRIVATE')]);
    rows.push(['class secretive is not a secret block', cleanJournalHtml('<p class="secretive">PUBLIC</p>').includes('PUBLIC')]);
    rows.push(['escaped Secret literal remains text', !journalEditorProblem('<p>&lt;section class="secret"&gt;literal&lt;/section&gt;</p>')]);
    setResults(rows.map(([name, pass]) => `${pass ? 'PASS' : 'FAIL'} — ${name}`));
  }
  function paste(html: string, name: string, shouldReject: boolean) {
    const element = document.querySelector<HTMLElement>('[contenteditable="true"]');
    if (!element) { record(`${name}: editor available`, false); return; }
    const before = element.innerHTML, beforeChanges = changesRef.current;
    const transfer = new DataTransfer(); transfer.setData('text/html', html); transfer.setData('text/plain', 'CLIPBOARD');
    element.focus(); element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    requestAnimationFrame(() => {
      record(`${name}: ${shouldReject ? 'no document mutation' : 'content inserted'}`, shouldReject ? element.innerHTML === before : element.innerHTML !== before);
      record(`${name}: ${shouldReject ? 'no onChange' : 'onChange emitted'}`, shouldReject ? changesRef.current === beforeChanges : changesRef.current > beforeChanges);
      if (shouldReject) record(`${name}: visible rejection`, Array.from(document.querySelectorAll('[role="alert"]')).some(node => node.textContent?.includes('Nothing pasted')));
    });
  }
  return <main><h1>Journal rich text browser checks</h1><p>Isolated fixture; synthetic clipboard events exercise the real editor. No campaign writes.</p>
    <button onClick={helpers}>Run HTML guards</button><button onClick={() => { setValue(initial); setProblem(null); }}>Load editable baseline</button><button onClick={() => setValue('<h2 id="jh-anchor">Preserved heading</h2><p>Text with <sup>2</sup>.</p>')}>Load unsupported source</button>
    <button onClick={() => paste('<p>PUBLIC</p><section class="secret">PRIVATE_CLIPBOARD</section>', 'Secret paste', true)}>Test Secret paste</button>
    <button onClick={() => paste('<p>Equation <sup>2</sup></p>', 'Unsupported paste', true)}>Test unsupported paste</button>
    <button onClick={() => paste('<h6>Heading six</h6><p><a href="#jh-test" title="Tooltip">Titled link</a></p>', 'Supported paste', false)}>Test supported paste</button>
    <p>onChange calls: {changes} · blocked callback: {problem || 'none'}</p>
    <RichText value={value} onChange={html => { changesRef.current++; setChanges(changesRef.current); setValue(html); }} onBlockedChange={setProblem}/>
    <h2>Current unmodified source / emitted value</h2><pre className="source">{value}</pre>
    <h2>Checks ({results.filter(row => row.startsWith('PASS')).length}/{results.length})</h2><ul className="results">{results.map((row, index) => <li key={index} className={row.startsWith('PASS') ? 'pass' : 'error'}>{row}</li>)}</ul>
  </main>;
}
const root = createRoot(document.getElementById('root')!);
root.render(<StrictMode><App/></StrictMode>);
const hot = (import.meta as ImportMeta & { hot?: { dispose: (callback: () => void) => void } }).hot;
hot?.dispose(() => root.unmount());
