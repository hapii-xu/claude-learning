import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { ThemeProvider } from '@/lib/theme';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Header } from '@/components/layout/Header';
import { Sidebar } from '@/components/layout/Sidebar';
import { ErrorBoundary } from '@/components/layout/ErrorBoundary';
import { ScrollToTop } from '@/components/layout/ScrollToTop';
import { KeyboardShortcutsDialog } from '@/components/layout/KeyboardShortcutsDialog';
import { ConsoleDrawer } from '@/components/console/ConsoleDrawer';
import { HomePage } from '@/routes/HomePage';
import { ModulePage } from '@/routes/ModulePage';
import { FileViewerPage } from '@/routes/FileViewerPage';
import { DocPage } from '@/routes/DocPage';
import { FileComparePage } from '@/routes/FileComparePage';
import { SearchPage } from '@/routes/SearchPage';
import { BrowsePage } from '@/routes/BrowsePage';
import { GraphPage } from '@/routes/GraphPage';
import { NotesPage } from '@/routes/NotesPage';
import { DashboardPage } from '@/routes/DashboardPage';
import { ChatPage } from '@/routes/ChatPage';
import { BookmarksPage } from '@/routes/BookmarksPage';
import { PathsPage } from '@/routes/PathsPage';
import { LearningPathPage } from '@/routes/LearningPathPage';
import { PackagesPage } from '@/routes/PackagesPage';
import { ArchitecturePage } from '@/routes/ArchitecturePage';
import { NotFoundPage } from '@/routes/NotFoundPage';

function AppLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();

  // Close sidebar on route change (mobile)
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  return (
    <div className="min-h-screen bg-surface-0">
      <ScrollToTop />
      <KeyboardShortcutsDialog />
      <Header onToggleSidebar={() => setSidebarOpen(prev => !prev)} />
      <div className="flex items-start">
        {/* Mobile overlay */}
        {sidebarOpen && (
          <div className="fixed inset-0 z-30 bg-black/40 lg:hidden" onClick={() => setSidebarOpen(false)} />
        )}
        <div
          className={`
            fixed inset-y-0 left-0 z-40 w-64 transform transition-transform duration-200 ease-in-out
            lg:sticky lg:top-14 lg:translate-x-0 lg:transition-none lg:self-start
            lg:h-[calc(100vh-3.5rem)] lg:shrink-0
            ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
          `}
        >
          <Sidebar />
        </div>
        <main className="flex-1 min-w-0">
          <ErrorBoundary>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/module/:moduleId" element={<ModulePage />} />
              <Route path="/file/*" element={<FileViewerPage />} />
              <Route path="/doc/*" element={<DocPage />} />
              <Route path="/compare/*" element={<FileComparePage />} />
              <Route path="/search" element={<SearchPage />} />
              <Route path="/browse/*" element={<BrowsePage />} />
              <Route path="/packages" element={<PackagesPage />} />
              <Route path="/architecture" element={<ArchitecturePage />} />
              <Route path="/graph" element={<GraphPage />} />
              <Route path="/notes" element={<NotesPage />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/chat" element={<ChatPage />} />
              <Route path="/bookmarks" element={<BookmarksPage />} />
              <Route path="/paths" element={<PathsPage />} />
              <Route path="/path/:pathId" element={<LearningPathPage />} />
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </ErrorBoundary>
        </main>
      </div>
      {/* Global Console Drawer */}
      <ConsoleDrawer />
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ThemeProvider defaultTheme="system">
        <TooltipProvider>
          <AppLayout />
        </TooltipProvider>
      </ThemeProvider>
    </BrowserRouter>
  );
}
