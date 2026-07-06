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
    expect(result?.suggestedConfig.startCommand).toBe('gunicorn --bind 0.0.0.0:$PORT app:app');
    expect(result?.suggestedConfig.port).toBe(5000);
  });

  it('detects FastAPI when "fastapi" is listed before "uvicorn" in requirements.txt', async () => {
    await fs.writeFile(path.join(tmpDir, 'requirements.txt'), 'fastapi\nuvicorn');
    await fs.writeFile(path.join(tmpDir, 'main.py'), '');

    const result = await pythonDetector.detect(tmpDir);

    expect(result?.type).toBe('fastapi');
    expect(result?.detectedBy).toBe('requirement:fastapi');
    expect(result?.suggestedConfig.startCommand).toBe(
      'uvicorn main:app --host 0.0.0.0 --port $PORT'
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

  it('warns when both requirements.txt and Pipfile exist, and prefers pipenv for install', async () => {
    await fs.writeFile(path.join(tmpDir, 'requirements.txt'), 'flask==2.0');
    await fs.writeFile(path.join(tmpDir, 'Pipfile'), '[packages]\nflask = "*"');

    const result = await pythonDetector.detect(tmpDir);

    expect(result?.warnings).toContainEqual(
      expect.stringContaining('Both requirements.txt and Pipfile found')
    );
    expect(result?.suggestedConfig.installCommand).toBe('pipenv install');
  });
});
