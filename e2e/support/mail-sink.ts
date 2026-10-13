import { createServer as createHttpServer } from 'node:http';
import { createServer as createSmtpServer, type Socket } from 'node:net';

interface Message {
  to: string;
  subject: string;
  text: string;
}

const smtpPort = Number(process.env['SINK_SMTP_PORT']);
const httpPort = Number(process.env['SINK_HTTP_PORT']);
if (!Number.isInteger(smtpPort) || !Number.isInteger(httpPort)) {
  throw new Error('Set SINK_SMTP_PORT and SINK_HTTP_PORT to the ports the sink should listen on.');
}

const outbox: Message[] = [];

function decodeBody(encoding: string, body: string): string {
  switch (encoding.toLowerCase()) {
    case 'base64':
      return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
    case 'quoted-printable':
      return body
        .replace(/=\r?\n/g, '')
        .replace(/=([0-9A-F]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    default:
      return body;
  }
}

function splitHead(raw: string): { headers: string; body: string } {
  const at = raw.indexOf('\r\n\r\n');
  if (at < 0) return { headers: raw, body: '' };
  return { headers: raw.slice(0, at).replace(/\r\n[ \t]+/g, ' '), body: raw.slice(at + 4) };
}

function header(headers: string, name: string): string {
  const match = new RegExp(`^${name}:[ \\t]*(.*)$`, 'im').exec(headers);
  return match?.[1]?.trim() ?? '';
}

function plainText(raw: string): string {
  const { headers, body } = splitHead(raw);
  const type = header(headers, 'content-type');
  const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1];
  if (boundary) {
    for (const part of body.split(`--${boundary}`)) {
      const text = plainText(part.replace(/^\r\n/, ''));
      if (text) return text;
    }
    return '';
  }
  if (!/^text\/plain/i.test(type || 'text/plain')) return '';
  return decodeBody(header(headers, 'content-transfer-encoding') || '7bit', body);
}

function record(recipient: string, raw: string): void {
  const { headers } = splitHead(raw);
  outbox.push({ to: recipient, subject: header(headers, 'subject'), text: plainText(raw) });
}

function serveSmtp(socket: Socket): void {
  let buffer = '';
  let recipients: string[] = [];
  let inData = false;
  socket.setEncoding('utf8');
  socket.write('220 mail-sink ESMTP\r\n');

  const handleLine = (line: string) => {
    const verb = line.slice(0, 4).toUpperCase();
    if (verb === 'EHLO' || verb === 'HELO') socket.write('250 mail-sink\r\n');
    else if (verb === 'MAIL') {
      recipients = [];
      socket.write('250 ok\r\n');
    } else if (verb === 'RCPT') {
      const address = /<([^>]+)>/.exec(line)?.[1];
      if (address) recipients.push(address);
      socket.write('250 ok\r\n');
    } else if (verb === 'DATA') {
      inData = true;
      socket.write('354 end with <CRLF>.<CRLF>\r\n');
    } else if (verb === 'QUIT') socket.end('221 bye\r\n');
    else socket.write('250 ok\r\n');
  };

  socket.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      if (inData) {
        const end = buffer.indexOf('\r\n.\r\n');
        if (end < 0) return;
        const raw = buffer.slice(0, end).replace(/^\.\./gm, '.');
        buffer = buffer.slice(end + 5);
        inData = false;
        for (const recipient of recipients) record(recipient, raw);
        socket.write('250 queued\r\n');
      } else {
        const eol = buffer.indexOf('\r\n');
        if (eol < 0) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        handleLine(line);
      }
    }
  });
  socket.on('error', () => socket.destroy());
}

createSmtpServer(serveSmtp).listen(smtpPort, '127.0.0.1');

createHttpServer((req, res) => {
  if (req.url === '/outbox' && req.method === 'GET') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(outbox));
    return;
  }
  res.statusCode = 404;
  res.end();
}).listen(httpPort, '127.0.0.1');
