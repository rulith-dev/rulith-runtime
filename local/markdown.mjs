// SPDX-License-Identifier: Apache-2.0
/** Render the common Markdown used in conversation. Raw HTML and remote images stay inert. */
export function renderMarkdown(value) {
  const esc = text => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
  const inline = text => {
    const tokens = []; const keep = html => '\u0000' + (tokens.push(html) - 1) + '\u0000'
    let safe = String(text).replace(/\u0000/g, '')
    safe = safe.replace(/`([^`\n]+)`/g, (_, code) => keep('<code>' + esc(code) + '</code>'))
    safe = safe.replace(/!?\[([^\]\n]+)\]\(([^\s)]+)\)/g, (all, label, href) => {
      if (all.startsWith('!')) return keep(esc(label) + ' (' + esc(href) + ')')
      if (!/^(https?:\/\/|mailto:|#)/i.test(href) || /[\x00-\x20]/.test(href)) return keep(esc(all))
      return keep('<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + esc(label) + '</a>')
    })
    safe = esc(safe).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>').replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    return safe.replace(/\u0000(\d+)\u0000/g, (_, index) => tokens[Number(index)] || '')
  }
  const cells = line => {
    const result=[];let cell='',code=false,escaped=false
    for(const c of line.trim().replace(/^\|/,'').replace(/\|$/,'')) {
      if(escaped){cell+=c;escaped=false;continue} if(c==='\\'){escaped=true;continue}
      if(c==='`')code=!code
      if(c==='|'&&!code){result.push(cell.trim());cell=''}else cell+=c
    }
    result.push(cell.trim());return result
  }
  const lines=String(value??'').replace(/\r\n?/g,'\n').split('\n'),html=[]
  const divider=line=>line.includes('|')&&cells(line).every(c=>/^:?-{3,}:?$/.test(c))
  for(let i=0;i<lines.length;) {
    const line=lines[i]
    if(!line.trim()){i++;continue}
    const fence=/^\s*(`{3,}|~{3,})(.*)$/.exec(line)
    if(fence){const content=[];i++;while(i<lines.length&&!new RegExp('^\\s*'+fence[1][0]+'{'+fence[1].length+',}\\s*$').test(lines[i]))content.push(lines[i++]);if(i<lines.length)i++;html.push('<pre><code>'+esc(content.join('\n'))+'</code></pre>');continue}
    const heading=/^\s{0,3}(#{1,6})\s+(.+)$/.exec(line)
    if(heading){const n=heading[1].length;html.push('<h'+n+'>'+inline(heading[2])+'</h'+n+'>');i++;continue}
    if(i+1<lines.length&&line.includes('|')&&divider(lines[i+1])) {
      const headers=cells(line);html.push('<div class="markdown-table"><table><thead><tr>'+headers.map(c=>'<th>'+inline(c)+'</th>').join('')+'</tr></thead><tbody>');i+=2
      while(i<lines.length&&lines[i].trim()&&lines[i].includes('|')){const row=cells(lines[i++]);html.push('<tr>'+headers.map((_,n)=>'<td>'+inline(row[n]||'')+'</td>').join('')+'</tr>')}
      html.push('</tbody></table></div>');continue
    }
    const item=/^\s*(?:([-+*])|\d+[.)])\s+(.+)$/.exec(line)
    if(item){const tag=item[1]?'ul':'ol';html.push('<'+tag+'>');while(i<lines.length){const next=/^\s*(?:([-+*])|\d+[.)])\s+(.+)$/.exec(lines[i]);if(!next||(next[1]?'ul':'ol')!==tag)break;html.push('<li>'+inline(next[2])+'</li>');i++;}html.push('</'+tag+'>');continue}
    if(/^\s*>/.test(line)){const quote=[];while(i<lines.length&&/^\s*>/.test(lines[i]))quote.push(inline(lines[i++].replace(/^\s*>\s?/,'')));html.push('<blockquote>'+quote.join('<br>')+'</blockquote>');continue}
    if(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)){html.push('<hr>');i++;continue}
    const paragraph=[inline(line)];i++
    while(i<lines.length&&lines[i].trim()&&!/^\s*(?:#{1,6}\s|[-+*]\s|\d+[.)]\s|>|`{3,}|~{3,})/.test(lines[i])&&!(i+1<lines.length&&divider(lines[i+1]))){paragraph.push(inline(lines[i++]));}
    html.push('<p>'+paragraph.join('<br>')+'</p>')
  }
  return html.join('')
}
