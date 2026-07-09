import { LucideIcon } from 'lucide-react';

export interface TabDef {
  id: string;
  label: string;
  icon?: LucideIcon;
}

function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: TabDef[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="border-b border-gray-200 dark:border-gray-700 mb-6 overflow-x-auto">
      <nav className="flex gap-1 -mb-px min-w-max">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => onChange(id)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
              active === id
                ? 'border-drop-600 text-drop-600 dark:text-drop-400'
                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            {Icon && <Icon className="w-4 h-4" />}
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}

export default Tabs;
