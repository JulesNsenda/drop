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
    <div className="mb-6 overflow-x-auto border-b" style={{ borderColor: 'var(--border, #e5e7eb)' }}>
      <nav className="flex min-w-max gap-1 -mb-px">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => onChange(id)}
            className={`flex items-center gap-2 whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition-colors dui-tab ${
              active === id ? 'dui-tab-active' : ''
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
