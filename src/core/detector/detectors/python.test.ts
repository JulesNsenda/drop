/**
 * Python Detector Tests
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { pythonDetector } from './python';

describe('pythonDetector', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-python-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('returns null when there is no requirements.txt, pyproject.toml, setup.py, or Pipfile', async () => {
    await fs.writeFile(path.join(tmpDir, 'readme.md'), '# not python');

    const result = await pythonDetector.detect(tmpDir);

    expect(result).toBeNull();
  });

  it('detects Django from manage.py, overriding any framework match in requirements.txt', async () => {
    await fs.writeFile(path.join(tmpDir, 'manage.py'), '');
    // flask appears in requirements, but manage.py detection short-circuits the
    // requirements.txt scan entirely (it only runs `if type === 'python'`).
    await fs.writeFile(path.join(tmpDir, 'requirements.txt'), 'django==4.0\nflask==2.0');

    const result = await pythonDetector.detect(tmpDir);

    expect(result?.type).toBe('django');
    expect(result?.framework).toBe('django');
    expect(result?.confidence).toBe(0.9);
    expect(result?.detectedBy).toBe('manage.py');
  });

  it('detects Flask from requirements.txt and builds a gunicorn start command from the entry point', async () => {
    await fs.writeFile(path.join(tmpDir, 'requirements.txt'), 'flask==2.0\nflask-cors');
    await fs.writeFile(path.join(tmpDir, 'app.py'), '');

    const result = await pythonDetector.detect(tmpDir);

    expect(result?.type).toBe('flask');
    expect(result?.framework).toBe('flask');
    expect(result?.confidence).toBe(0.85);
    expect(result?.detectedBy).toBe('requirement:flask');
    expect(result?.suggestedConfig.startCommand).toBe(
      'python -m gunicorn --bind 0.0.0.0:$PORT app:app'
    );
    expect(result?.suggestedConfig.port).toBe(5000);
  });

  it('detects FastAPI when "fastapi" is listed before "uvicorn" in requirements.txt', async () => {
    await fs.writeFile(path.join(tmpDir, 'requirements.txt'), 'fastapi\nuvicorn');
    await fs.writeFile(path.join(tmpDir, 'main.py'), '');

    const result = await pythonDetector.detect(tmpDir);

    expect(result?.type).toBe('fastapi');
    expect(result?.detectedBy).toBe('requirement:fastapi');
    expect(result?.suggestedConfig.startCommand).toBe(
      'python -m uvicorn main:app --host 0.0.0.0 --port $PORT'
    );
    expect(result?.suggestedConfig.port).toBe(8000);
  });

  it('does NOT promote to fastapi when only "uvicorn" is present (base confidence tie)', async () => {
    // FRAMEWORK_PATTERNS['uvicorn'].confidence is 0.70, exactly equal to the
    // detector's default `confidence = 0.70`. The update guard is a strict `>`,
    // so a uvicorn-only requirements.txt never overrides the default - the app
    // is left classified as generic 'python' instead of 'fastapi'.
    await fs.writeFile(path.join(tmpDir, 'requirements.txt'), 'uvicorn');
    await fs.writeFile(path.join(tmpDir, 'main.py'), '');

    const result = await pythonDetector.detect(tmpDir);

    expect(result?.type).toBe('python');
    expect(result?.framework).toBeNull();
    expect(result?.confidence).toBe(0.7);
  });

  it('does NOT apply the wsgi/gunicorn framework since its confidence is below the default', async () => {
    // Same boundary issue as uvicorn: FRAMEWORK_PATTERNS['gunicorn'].confidence
    // is 0.60, which can never exceed the default 0.70, so this pattern is
    // effectively unreachable.
    await fs.writeFile(path.join(tmpDir, 'requirements.txt'), 'gunicorn');
    await fs.writeFile(path.join(tmpDir, 'app.py'), '');

    const result = await pythonDetector.detect(tmpDir);

    expect(result?.type).toBe('python');
    expect(result?.framework).toBeNull();
  });

  it('uses the discovered entry point and PYTHONUNBUFFERED env for a generic Python app', async () => {
    await fs.writeFile(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "app"');
    await fs.writeFile(path.join(tmpDir, 'run.py'), '');

    const result = await pythonDetector.detect(tmpDir);

    expect(result?.type).toBe('python');
    expect(result?.metadata.entryPoint).toBe('run.py');
    expect(result?.suggestedConfig.startCommand).toBe('python run.py');
    expect(result?.suggestedConfig.port).toBe(8000);
    expect(result?.suggestedConfig.env).toEqual({ PYTHONUNBUFFERED: '1' });
    expect(result?.warnings).not.toContainEqual(expect.stringContaining('No entry point'));
  });

  it('warns when no entry point file can be found for a non-Django app', async () => {
    await fs.writeFile(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "app"');

    const result = await pythonDetector.detect(tmpDir);

    expect(result?.type).toBe('python');
    expect(result?.warnings).toContainEqual(
      expect.stringContaining('No entry point file found')
    );
  });

  it('warns when both requirements.txt and Pipfile exist', async () => {
    await fs.writeFile(path.join(tmpDir, 'requirements.txt'), 'flask==2.0');
    await fs.writeFile(path.join(tmpDir, 'Pipfile'), '[packages]\nflask = "*"');

    const result = await pythonDetector.detect(tmpDir);

    expect(result?.warnings).toContainEqual(
      expect.stringContaining('Both requirements.txt and Pipfile found')
    );
  });

  // Regression: the detector used to suggest a bare `pip install -r
  // requirements.txt` (and `pipenv install`). platform.buildApp feeds
  // suggestedConfig.installCommand straight into the build context, where
  // PythonBuildStrategy honors it *ahead of* its own in-app-dir venv logic —
  // so suggesting anything here silently disabled the venv install and broke
  // every Python app with dependencies, in both isolation modes.
  it.each([
    ['requirements.txt', 'flask==2.0'],
    ['Pipfile', '[packages]\nflask = "*"'],
    ['pyproject.toml', '[tool.poetry]\nname = "x"'],
  ])('never suggests an install command for a %s project', async (manifest, body) => {
    await fs.writeFile(path.join(tmpDir, manifest), body);
    await fs.writeFile(path.join(tmpDir, 'app.py'), '');

    const result = await pythonDetector.detect(tmpDir);

    expect(result?.suggestedConfig.installCommand).toBeUndefined();
  });

  it('emits python -m gunicorn for the Django framework default (never a bare gunicorn binary)', async () => {
    await fs.writeFile(path.join(tmpDir, 'manage.py'), '');
    await fs.writeFile(path.join(tmpDir, 'requirements.txt'), 'django==4.0');

    const result = await pythonDetector.detect(tmpDir);

    expect(result?.type).toBe('django');
    expect(result?.suggestedConfig.startCommand).toBe(
      'python -m gunicorn --bind 0.0.0.0:$PORT wsgi:application'
    );
  });

  describe('entry-point-only detection (no dependency manifest)', () => {
    it('detects a Python app from an entry point + Procfile alone, at confidence 0.5', async () => {
      await fs.writeFile(path.join(tmpDir, 'app.py'), '');
      await fs.writeFile(path.join(tmpDir, 'Procfile'), 'web: python3 app.py\n');

      const result = await pythonDetector.detect(tmpDir);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('python');
      expect(result?.confidence).toBe(0.5);
      expect(result?.detectedBy).toBe('entrypoint+procfile');
      // The Procfile's web command wins over the guessed `python app.py` default.
      expect(result?.suggestedConfig.startCommand).toBe('python3 app.py');
    });

    it('detects a Python app from an entry point alone, with no Procfile', async () => {
      await fs.writeFile(path.join(tmpDir, 'main.py'), '');

      const result = await pythonDetector.detect(tmpDir);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('python');
      expect(result?.confidence).toBe(0.5);
      expect(result?.detectedBy).toBe('entrypoint');
      expect(result?.suggestedConfig.startCommand).toBe('python main.py');
    });

    it('returns null for a truly empty directory (no manifest, no entry point, no Procfile)', async () => {
      const result = await pythonDetector.detect(tmpDir);

      expect(result).toBeNull();
    });

    it('returns null when only a Procfile exists - a Procfile alone is not a Python signal', async () => {
      await fs.writeFile(path.join(tmpDir, 'Procfile'), 'web: node server.js\n');

      const result = await pythonDetector.detect(tmpDir);

      expect(result).toBeNull();
    });
  });

  describe('-r/-c include resolution in requirements.txt', () => {
    it('follows a -r include so "requirements.txt" containing only "-r deps.txt" still detects the framework', async () => {
      await fs.writeFile(path.join(tmpDir, 'requirements.txt'), '-r deps.txt\n');
      await fs.writeFile(path.join(tmpDir, 'deps.txt'), 'fastapi\n');
      await fs.writeFile(path.join(tmpDir, 'main.py'), '');

      const result = await pythonDetector.detect(tmpDir);

      expect(result?.type).toBe('fastapi');
      expect(result?.detectedBy).toBe('requirement:fastapi');
    });

    it('resolves a nested -r include relative to the directory of the file that references it (not the app root)', async () => {
      // requirements.txt -> reqs/base.txt -> "-r more.txt" (sibling of base.txt,
      // i.e. reqs/more.txt) - resolving that "-r more.txt" against the app root
      // instead of base.txt's own directory (reqs/) would silently miss the file
      // and only "flask" would be seen; resolving it correctly also picks up
      // fastapi from reqs/more.txt.
      await fs.mkdir(path.join(tmpDir, 'reqs'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'requirements.txt'), '-r reqs/base.txt\n');
      await fs.writeFile(path.join(tmpDir, 'reqs', 'base.txt'), '-r more.txt\nflask\n');
      await fs.writeFile(path.join(tmpDir, 'reqs', 'more.txt'), 'fastapi\n');
      await fs.writeFile(path.join(tmpDir, 'app.py'), '');

      const result = await pythonDetector.detect(tmpDir);

      expect(result?.type).toBe('fastapi');
    });

    it('also follows -c/--constraint includes', async () => {
      await fs.writeFile(path.join(tmpDir, 'requirements.txt'), '-c constraints.txt\n');
      await fs.writeFile(path.join(tmpDir, 'constraints.txt'), 'fastapi\n');
      await fs.writeFile(path.join(tmpDir, 'main.py'), '');

      const result = await pythonDetector.detect(tmpDir);

      expect(result?.type).toBe('fastapi');
    });

    it('refuses a -r include that points outside the app directory', async () => {
      await fs.mkdir(path.join(tmpDir, 'app'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'app', 'requirements.txt'), '-r ../evil.txt\n');
      await fs.writeFile(path.join(tmpDir, 'evil.txt'), 'fastapi\n');
      await fs.writeFile(path.join(tmpDir, 'app', 'main.py'), '');

      const result = await pythonDetector.detect(path.join(tmpDir, 'app'));

      // The outside-the-app-dir include is never read, so fastapi never surfaces.
      expect(result?.type).toBe('python');
      expect(result?.framework).toBeNull();
    });

    it('refuses an absolute-path -r include', async () => {
      await fs.writeFile(path.join(tmpDir, 'evil.txt'), 'fastapi\n');
      const absoluteEvil = path.join(tmpDir, 'evil.txt');
      await fs.writeFile(path.join(tmpDir, 'requirements.txt'), `-r ${absoluteEvil}\n`);
      await fs.writeFile(path.join(tmpDir, 'main.py'), '');

      const result = await pythonDetector.detect(tmpDir);

      expect(result?.type).toBe('python');
      expect(result?.framework).toBeNull();
    });

    it('is cycle-safe when -r includes reference each other', async () => {
      await fs.writeFile(path.join(tmpDir, 'requirements.txt'), '-r deps.txt\nflask\n');
      await fs.writeFile(path.join(tmpDir, 'deps.txt'), '-r requirements.txt\nfastapi\n');
      await fs.writeFile(path.join(tmpDir, 'app.py'), '');

      const result = await pythonDetector.detect(tmpDir);

      // Must terminate rather than looping/stack-overflowing on the cycle. The
      // flattened list ends up ['fastapi', 'flask'] (deps.txt's second visit of
      // requirements.txt is skipped by the visited-set); fastapi is matched
      // first and flask's equal 0.85 confidence doesn't beat it (strict `>`).
      expect(result?.type).toBe('fastapi');
    });
  });
});
