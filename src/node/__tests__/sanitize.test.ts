import { describe, expect, it } from 'vitest';
import { sanitizePtyText } from '../tools/sanitize.js';

const ESC = '\x1b';
const BEL = '\x07';

describe('sanitizePtyText', () => {
  it('leaves plain text untouched', () => {
    expect(sanitizePtyText('hello\nworld\n')).toBe('hello\nworld\n');
  });

  it('strips CSI color and mode sequences', () => {
    expect(sanitizePtyText(`${ESC}[31mred${ESC}[0m plain`)).toBe('red plain');
    expect(sanitizePtyText(`${ESC}[?2004hbash$ ${ESC}[?2004l`)).toBe('bash$ ');
  });

  it('strips OSC sequences terminated by BEL or ST', () => {
    expect(sanitizePtyText(`${ESC}]0;window title${BEL}visible`)).toBe('visible');
    expect(sanitizePtyText(`${ESC}]8;;http://x${ESC}\\link${ESC}]8;;${ESC}\\ text`)).toBe('link text');
  });

  it('normalizes CRLF', () => {
    expect(sanitizePtyText('a\r\nb\r\n')).toBe('a\nb\n');
  });

  it('applies carriage-return redraws: the last segment wins', () => {
    expect(sanitizePtyText('downloading 10%\rdownloading 90%\rdone\n')).toBe('done\n');
  });

  it('drops residual control bytes but keeps tab and newline', () => {
    expect(sanitizePtyText('a\x01b\x7fc\td\ne')).toBe('abc\td\ne');
  });

  it('a trailing bare carriage return keeps the prior text', () => {
    expect(sanitizePtyText('progress 99%\r')).toBe('progress 99%');
    expect(sanitizePtyText('a\rb\r')).toBe('b');
  });

  it('a trailing partial escape drops its tail', () => {
    expect(sanitizePtyText('abc\x1b[3')).toBe('abc');
    expect(sanitizePtyText('abc\x1b]0;title')).toBe('abc');
  });

  it('strips DCS, APC and PM payloads up to ST', () => {
    expect(sanitizePtyText(`${ESC}P1;2|payload${ESC}\\visible`)).toBe('visible');
    expect(sanitizePtyText(`${ESC}_application-payload${ESC}\\visible`)).toBe('visible');
    expect(sanitizePtyText(`${ESC}^private-message${ESC}\\visible`)).toBe('visible');
    // A payload may span lines and hold other escape-looking bytes.
    expect(sanitizePtyText(`a${ESC}Pline one\n${ESC}[31mred${ESC}\\b`)).toBe('ab');
  });

  it('drops an unterminated DCS/APC/PM payload to the capture end', () => {
    expect(sanitizePtyText(`abc${ESC}Ppayload`)).toBe('abc');
    expect(sanitizePtyText(`abc${ESC}_payload`)).toBe('abc');
    expect(sanitizePtyText(`abc${ESC}^payload`)).toBe('abc');
  });

  it('strips raw C1 control bytes', () => {
    expect(sanitizePtyText('a\x85b\x9bc')).toBe('abc');
    expect(sanitizePtyText('x\x90y\x9dz\x9f')).toBe('xyz');
  });

  it('never splits a surrogate pair', () => {
    expect(sanitizePtyText(`ok 🌍 ${ESC}[31m🚀${ESC}[0m`)).toBe('ok 🌍 🚀');
  });

  it('handles an empty string', () => {
    expect(sanitizePtyText('')).toBe('');
  });
});
