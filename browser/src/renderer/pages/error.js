'use strict';
const params = new URLSearchParams(location.search);
const url = params.get('url') || '';
const desc = params.get('desc') || '';
const messages = {
  ERR_NAME_NOT_RESOLVED: 'The website address could not be found. Check the spelling.',
  ERR_INTERNET_DISCONNECTED: 'This computer is not connected to the internet.',
  ERR_CONNECTION_REFUSED: 'The website refused to connect.',
  ERR_CONNECTION_TIMED_OUT: 'The website took too long to respond.',
  ERR_CERT_AUTHORITY_INVALID: 'The website security certificate is not trusted.',
};
document.getElementById('desc').textContent = messages[desc] || desc || 'Something went wrong while loading this page.';
document.getElementById('url').textContent = url;
document.getElementById('retry').addEventListener('click', () => {
  if (/^https?:\/\//.test(url)) location.href = url;
});
