import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Breadcrumbs } from '@/components/layout/Breadcrumbs';
import { Badge } from '@/components/ui/badge';
import { packagesMeta, PACKAGE_CATEGORIES } from '@/data/packagesMeta';
import type { PackageMeta, PackageCategory } from '@/data/packagesMeta';
import { Boxes, Search, ExternalLink, FileCode } from 'lucide-react';

export function PackagesPage() {
  const [query, setQuery] = useState('');

  const filtered = query
    ? packagesMeta.filter(
        p =>
          p.name.toLowerCase().includes(query.toLowerCase()) ||
          p.title.toLowerCase().includes(query.toLowerCase()) ||
          p.purpose.toLowerCase().includes(query.toLowerCase()),
      )
    : packagesMeta;

  const categories = Object.keys(PACKAGE_CATEGORIES) as PackageCategory[];

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 animate-fade-up">
      <Breadcrumbs />

      <div className="flex items-center gap-3 mb-6">
        <div className="size-10 rounded-lg bg-brand/10 flex items-center justify-center shrink-0">
          <Boxes className="size-5 text-brand" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-foreground">Packages 学习地图</h1>
          <p className="text-sm text-muted-foreground">17 个 Bun workspace 子包，按功能域分组</p>
        </div>
      </div>

      <div className="relative mb-6">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="搜索包名、用途..."
          className="w-full pl-9 pr-4 py-2 text-sm rounded-lg border bg-background"
        />
      </div>

      <div className="space-y-8">
        {categories.map(cat => {
          const pkgs = filtered.filter(p => p.category === cat);
          if (pkgs.length === 0) return null;
          const catInfo = PACKAGE_CATEGORIES[cat];
          return (
            <section key={cat} id={cat}>
              <div className="flex items-baseline gap-2 mb-3">
                <h2 className="text-base font-semibold text-foreground">{catInfo.label}</h2>
                <span className="text-xs text-muted-foreground">{catInfo.description}</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {pkgs.map(pkg => (
                  <PackageCard key={pkg.path} pkg={pkg} />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function PackageCard({ pkg }: { pkg: PackageMeta }) {
  return (
    <div className="rounded-xl border bg-card p-4 hover:border-brand/30 transition-colors">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div>
          <span className="text-sm font-semibold text-foreground">{pkg.title}</span>
          {pkg.scope && (
            <Badge variant="secondary" className="ml-2 text-[9px] px-1.5">
              {pkg.scope}
            </Badge>
          )}
        </div>
        <Link
          to={`/browse/${pkg.path}`}
          className="text-[10px] text-muted-foreground hover:text-brand flex items-center gap-0.5 shrink-0"
        >
          <ExternalLink className="size-3" />
          浏览
        </Link>
      </div>
      <code className="text-[10px] text-muted-foreground block mb-2">{pkg.name}</code>
      <p className="text-xs text-muted-foreground leading-relaxed mb-3">{pkg.purpose}</p>
      {pkg.highlights && pkg.highlights.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {pkg.highlights.slice(0, 3).map(h => (
            <span key={h} className="text-[9px] bg-brand/10 text-brand/80 px-1.5 py-0.5 rounded">
              {h}
            </span>
          ))}
        </div>
      )}
      {pkg.entryFiles && pkg.entryFiles.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-1">
          {pkg.entryFiles.slice(0, 2).map(f => (
            <Link
              key={f}
              to={`/file/${f}`}
              className="flex items-center gap-1 text-[9px] text-blue-500 hover:underline"
            >
              <FileCode className="size-2.5" />
              {f.split('/').pop()}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
