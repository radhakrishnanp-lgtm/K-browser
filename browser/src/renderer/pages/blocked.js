'use strict';
const params = new URLSearchParams(location.search);
const url = params.get('url') || '';
const reason = params.get('reason') || '';
document.getElementById('url').textContent = url;
if (reason === 'scheme') {
  document.getElementById('title').textContent = 'This address cannot be opened';
  document.getElementById('text').textContent = 'This kind of address (for example javascript:, file: or view-source:) is disabled in K-Browser.';
  document.getElementById('request').hidden = true;
} else if (params.get('rule')) {
  document.getElementById('rule').textContent = `Matched rule: ${params.get('rule')}`;
} else if (reason === 'default') {
  document.getElementById('rule').textContent = 'Only approved websites can be opened.';
}
document.getElementById('back').addEventListener('click', () => history.length > 1 ? history.back() : (location.href = 'kb://newtab'));
document.getElementById('request').addEventListener('click', async () => {
  await fetch(`kb://blocked/request?url=${encodeURIComponent(url)}`);
  document.getElementById('request').hidden = true;
  document.getElementById('sent').hidden = false;
});
