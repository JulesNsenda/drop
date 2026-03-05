import { useState, useRef, DragEvent } from 'react';
import { FolderUp, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { useToast } from '../components/Toast';
import { getAuthHeaders } from '../hooks/useAuth';

type DeployStatus = 'idle' | 'uploading' | 'success' | 'error';

function DeployPage() {
  const [dragOver, setDragOver] = useState(false);
  const [status, setStatus] = useState<DeployStatus>('idle');
  const [appName, setAppName] = useState('');
  const [message, setMessage] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  };

  const handleDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      await uploadFiles(files);
    }
  };

  const handleFileSelect = async () => {
    const files = fileInputRef.current?.files;
    if (files && files.length > 0) {
      await uploadFiles(files);
    }
  };

  const uploadFiles = async (files: FileList) => {
    setStatus('uploading');
    setMessage('');

    const formData = new FormData();
    for (let i = 0; i < files.length; i++) {
      formData.append('files', files[i]);
    }
    if (appName.trim()) {
      formData.append('name', appName.trim());
    }

    try {
      const res = await fetch('/api/v1/apps/deploy', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: formData,
      });

      const json = await res.json();
      if (json.success) {
        setStatus('success');
        setMessage(json.data?.message || 'Application deployed successfully');
        toast('success', `Deployed ${json.data?.name || 'application'} successfully`);
        setAppName('');
      } else {
        setStatus('error');
        setMessage(json.error?.message || 'Deployment failed');
        toast('error', json.error?.message || 'Deployment failed');
      }
    } catch (err) {
      setStatus('error');
      setMessage(err instanceof Error ? err.message : 'Network error');
      toast('error', 'Failed to connect to server');
    }
  };

  const resetState = () => {
    setStatus('idle');
    setMessage('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Deploy</h1>
        <p className="text-gray-500 dark:text-gray-400">Upload files to deploy a new application</p>
      </div>

      {/* App name (optional) */}
      <div className="mb-4 max-w-md">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Application Name (optional)
        </label>
        <input
          type="text"
          value={appName}
          onChange={(e) => setAppName(e.target.value)}
          placeholder="my-app"
          pattern="^[a-zA-Z0-9][a-zA-Z0-9_-]*$"
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-drop-500 focus:border-transparent outline-none"
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Letters, numbers, hyphens, and underscores. Auto-generated if empty.
        </p>
      </div>

      {/* Drop zone */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => status !== 'uploading' && fileInputRef.current?.click()}
        className={`relative max-w-2xl border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-all ${
          dragOver
            ? 'border-drop-500 bg-drop-50 dark:bg-drop-900/20'
            : status === 'success'
              ? 'border-green-300 bg-green-50 dark:bg-green-900/20'
              : status === 'error'
                ? 'border-red-300 bg-red-50 dark:bg-red-900/20'
                : 'border-gray-300 dark:border-gray-600 hover:border-drop-400 hover:bg-gray-50 dark:hover:bg-gray-800'
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileSelect}
          className="hidden"
          // Allow common web app files
          accept=".js,.ts,.jsx,.tsx,.py,.go,.html,.css,.json,.yaml,.yml,.toml,.mod,.sum,.txt,.md,.env,.lock"
        />

        {status === 'idle' && (
          <>
            <FolderUp className="w-16 h-16 text-gray-400 dark:text-gray-500 mx-auto mb-4" />
            <p className="text-lg font-medium text-gray-700 dark:text-gray-300 mb-2">
              Drag & drop files here
            </p>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              or click to browse. Upload your application files to deploy.
            </p>
          </>
        )}

        {status === 'uploading' && (
          <>
            <Loader2 className="w-16 h-16 text-drop-500 mx-auto mb-4 animate-spin" />
            <p className="text-lg font-medium text-gray-700 dark:text-gray-300 mb-2">
              Deploying...
            </p>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Uploading and building your application
            </p>
          </>
        )}

        {status === 'success' && (
          <>
            <CheckCircle className="w-16 h-16 text-green-500 mx-auto mb-4" />
            <p className="text-lg font-medium text-green-700 dark:text-green-400 mb-2">
              Deployed!
            </p>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">{message}</p>
            <button
              onClick={(e) => { e.stopPropagation(); resetState(); }}
              className="px-4 py-2 bg-drop-600 text-white rounded-lg hover:bg-drop-700"
            >
              Deploy another
            </button>
          </>
        )}

        {status === 'error' && (
          <>
            <AlertCircle className="w-16 h-16 text-red-400 mx-auto mb-4" />
            <p className="text-lg font-medium text-red-700 dark:text-red-400 mb-2">
              Deployment failed
            </p>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">{message}</p>
            <button
              onClick={(e) => { e.stopPropagation(); resetState(); }}
              className="px-4 py-2 bg-drop-600 text-white rounded-lg hover:bg-drop-700"
            >
              Try again
            </button>
          </>
        )}
      </div>

      {/* Instructions */}
      <div className="mt-8 max-w-2xl">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
          Or deploy via the filesystem
        </h3>
        <div className="bg-gray-900 dark:bg-gray-800 rounded-lg p-4">
          <code className="text-sm text-green-400">
            {navigator.platform.includes('Win') ? (
              <>
                <span className="text-gray-500"># Copy your app folder to:</span>
                {'\n'}C:\drop\data\webapps\my-app\
              </>
            ) : (
              <>
                <span className="text-gray-500"># Copy your app folder to:</span>
                {'\n'}cp -r ./my-app /var/drop/data/webapps/
              </>
            )}
          </code>
        </div>
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          DROP will automatically detect, build, and start your application.
        </p>
      </div>
    </div>
  );
}

export default DeployPage;
