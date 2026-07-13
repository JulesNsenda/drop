import { parseProcfileContent, getWebCommand, readProcfile } from './procfile';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

describe('procfile parser', () => {
  it('parses a web process command verbatim (keeps inner spaces and $PORT)', () => {
    const procs = parseProcfileContent(
      'web: python3 -m uvicorn main:app --host 0.0.0.0 --port $PORT\n'
    );
    expect(procs).toEqual({
      web: 'python3 -m uvicorn main:app --host 0.0.0.0 --port $PORT',
    });
    expect(getWebCommand(procs)).toBe('python3 -m uvicorn main:app --host 0.0.0.0 --port $PORT');
  });

  it('parses multiple processes and ignores blanks and full-line comments', () => {
    const procs = parseProcfileContent(
      '# a comment\n\nweb: python3 app.py\nworker: celery -A app worker\n   \n'
    );
    expect(procs).toEqual({
      web: 'python3 app.py',
      worker: 'celery -A app worker',
    });
  });

  it('does not strip inline # (part of the command, per Heroku)', () => {
    const procs = parseProcfileContent('web: echo "a # b"\n');
    expect(procs).toEqual({ web: 'echo "a # b"' });
  });

  it('last definition wins for a duplicate process name', () => {
    const procs = parseProcfileContent('web: first\nweb: second\n');
    expect(procs).toEqual({ web: 'second' });
  });

  it('returns null for empty / comment-only / process-less content', () => {
    expect(parseProcfileContent('')).toBeNull();
    expect(parseProcfileContent('# just a comment\n')).toBeNull();
    expect(parseProcfileContent('not a process line\n')).toBeNull();
  });

  it('getWebCommand returns null when there is no web process', () => {
    expect(getWebCommand({ worker: 'celery -A app worker' })).toBeNull();
    expect(getWebCommand(null)).toBeNull();
  });

  it('readProcfile returns null when the file is absent', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-procfile-'));
    try {
      expect(await readProcfile(dir)).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('readProcfile reads and parses an on-disk Procfile', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-procfile-'));
    try {
      await fs.writeFile(path.join(dir, 'Procfile'), 'web: python3 app.py\n');
      expect(await readProcfile(dir)).toEqual({ web: 'python3 app.py' });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
