import {
    Activity,
    AlertTriangle,
    Boxes,
    Box,
    ChevronLeft,
    ChevronRight,
    CircleGauge,
    Cpu,
    Database,
    Download,
    ExternalLink,
    FileCode2,
    HardDrive,
    Image,
    History,
    LogOut,
    Menu,
    MemoryStick,
    Moon,
    Network,
    Pencil,
    Play,
    Plus,
    RefreshCw,
    RotateCw,
    Save,
    Search,
    Server,
    Settings,
    Square,
    Sun,
    TerminalSquare,
    Trash2,
    Unplug,
    X,
} from "lucide-react";

const icons = {
    activity: Activity,
    alert: AlertTriangle,
    boxes: Boxes,
    box: Box,
    chevronLeft: ChevronLeft,
    chevronRight: ChevronRight,
    dashboard: CircleGauge,
    cpu: Cpu,
    database: Database,
    download: Download,
    externalLink: ExternalLink,
    compose: FileCode2,
    volume: HardDrive,
    image: Image,
    history: History,
    logout: LogOut,
    menu: Menu,
    memory: MemoryStick,
    moon: Moon,
    network: Network,
    edit: Pencil,
    play: Play,
    plus: Plus,
    refresh: RefreshCw,
    restart: RotateCw,
    save: Save,
    search: Search,
    server: Server,
    settings: Settings,
    stop: Square,
    sun: Sun,
    terminal: TerminalSquare,
    delete: Trash2,
    disconnect: Unplug,
    close: X,
};

export type IconName = keyof typeof icons;

export function Icon({ name, size = 18, strokeWidth = 1.8, className } : {
    name: IconName;
    size?: number;
    strokeWidth?: number;
    className?: string;
}) {
    const Component = icons[name];
    return <Component aria-hidden="true" className={className} size={size} strokeWidth={strokeWidth} />;
}
