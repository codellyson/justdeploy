// Central icon set. UI icons from Lucide, framework/brand logos from Simple Icons.
// All inherit currentColor so they stay on-theme (no multicolor brand logos).
import {
  LuChevronRight, LuArrowLeft, LuArrowUpRight, LuPlus, LuLogOut, LuSun, LuMoon,
  LuCheck, LuX, LuCopy, LuTrash2, LuRotateCcw, LuTerminal, LuDatabase, LuFileCode2,
} from 'react-icons/lu';
import { SiReact, SiVite, SiNextdotjs, SiAdonisjs, SiPostgresql, SiSqlite } from 'react-icons/si';

export const Icon = {
  ChevronRight: LuChevronRight,
  ArrowLeft: LuArrowLeft,
  ExternalLink: LuArrowUpRight,
  Plus: LuPlus,
  LogOut: LuLogOut,
  Sun: LuSun,
  Moon: LuMoon,
  Check: LuCheck,
  X: LuX,
  Copy: LuCopy,
  Trash: LuTrash2,
  Rollback: LuRotateCcw,
  Terminal: LuTerminal,
  Database: LuDatabase,
};

const TYPE_ICON = {
  react: SiReact,
  vite: SiVite,
  static: LuFileCode2,
  adonis: SiAdonisjs,
  nextjs: SiNextdotjs,
  postgres: SiPostgresql,
  sqlite: SiSqlite,
};

export function TypeIcon({ type, className }) {
  const I = TYPE_ICON[type] || LuFileCode2;
  return <I className={className} />;
}
