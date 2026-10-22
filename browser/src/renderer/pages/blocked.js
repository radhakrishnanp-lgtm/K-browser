'use strict';
const params = new URLSearchParams(location.search);
const url = params.get('url') || '';
const reason = params.get('reason') || '';
const $ = (id) => document.getElementById(id);
$('url').textContent = url;

function noRequest() {
  $('request-form').hidden = true;
  $('back-only').hidden = false;
}

if (reason === 'scheme') {
  $('title').textContent = 'This address cannot be opened';
  $('text').textContent = 'This kind of address (for example javascript:, file: or view-source:) is disabled in K-Browser.';
  noRequest();
} else if (reason === 'seats') {
  document.querySelector('.icon').textContent = '\u{1f4ba}';
  $('title').textContent = 'All seats are in use';
  $('text').textContent = params.get('msg') || 'Every licence for this site is in use right now.';
  noRequest();
} else if (params.get('rule')) {
  $('rule').textContent = `Matched rule: ${params.get('rule')}`;
} else if (reason === 'default') {
  $('rule').textContent = 'Only approved websites can be opened.';
}

const back = () => (history.length > 1 ? history.back() : (location.href = 'kb://newtab'));
$('back').addEventListener('click', back);
$('back2').addEventListener('click', back);
$('request-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await fetch(`kb://blocked/request?url=${encodeURIComponent(url)}&reason=${encodeURIComponent($('reason').value.trim())}`);
  $('request-form').hidden = true;
  $('sent').hidden = false;
});
