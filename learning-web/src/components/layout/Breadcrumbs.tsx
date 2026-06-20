import { Link, useLocation } from 'react-router-dom';
import { ChevronRight, Home } from 'lucide-react';
import { getModuleById, findModuleByFilePath } from '@/data/modules';
import { directoryDescriptions } from '@/data/directoryDescriptions';

interface BreadcrumbItem {
  label: string;
  to?: string;
}

export function Breadcrumbs() {
  const location = useLocation();
  const items = buildBreadcrumbs(location.pathname);

  if (items.length <= 1) return null;

  return (
    <nav className="flex items-center gap-1 text-sm text-muted-foreground mb-4">
      {items.map((item, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <ChevronRight className="size-3.5 opacity-40" />}
          {item.to ? (
            <Link to={item.to} className="hover:text-foreground transition-colors flex items-center gap-1">
              {i === 0 && <Home className="size-3.5" />}
              {item.label}
            </Link>
          ) : (
            <span className="text-foreground font-medium">{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

function buildBreadcrumbs(pathname: string): BreadcrumbItem[] {
  const items: BreadcrumbItem[] = [{ label: '首页', to: '/' }];

  if (pathname === '/') return items;

  const moduleMatch = pathname.match(/^\/module\/(.+)$/);
  if (moduleMatch) {
    const mod = getModuleById(moduleMatch[1]);
    if (mod) {
      items.push({ label: mod.group.title });
      items.push({ label: mod.title });
    }
    return items;
  }

  const fileMatch = pathname.match(/^\/file\/(.+)$/);
  if (fileMatch) {
    const filePath = fileMatch[1];
    const mod = findModuleByFilePath(filePath);
    if (mod) {
      items.push({ label: mod.group.title });
      items.push({ label: mod.title, to: `/module/${mod.id}` });
    }
    // 显示文件路径的最后两部分
    const parts = filePath.split('/');
    const displayPath = parts.length > 2 ? `.../${parts.slice(-2).join('/')}` : filePath;
    items.push({ label: displayPath });
    return items;
  }

  const browseMatch = pathname.match(/^\/browse(\/(.+))?$/);
  if (browseMatch) {
    const browsePath = browseMatch[2];
    items.push({ label: '目录浏览', to: '/browse' });
    if (browsePath) {
      const parts = browsePath.split('/');
      let accumulated = '';
      for (let i = 0; i < parts.length; i++) {
        accumulated += (accumulated ? '/' : '') + parts[i];
        const desc = directoryDescriptions[accumulated];
        const label = desc?.title || parts[i];
        const isLast = i === parts.length - 1;
        items.push({ label, to: isLast ? undefined : `/browse/${accumulated}` });
      }
    }
    return items;
  }

  if (pathname === '/packages') {
    items.push({ label: 'Packages 地图' });
    return items;
  }

  return items;
}
