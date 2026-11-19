// C# 5 / .NET Framework 4.8. Read-only game observation and positioning of NOVA's own window.
// Only NOVA-owned standard dialogs accept native navigation keys. Never sends input to games or other applications.
using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32;
namespace Nova {
 public static class ConsoleHost {
  [StructLayout(LayoutKind.Sequential)] struct Pad {public ushort Buttons;public byte LT,RT;public short LX,LY,RX,RY;}
  [StructLayout(LayoutKind.Sequential)] struct Rect {public int Left,Top,Right,Bottom;}
  [StructLayout(LayoutKind.Sequential)] struct Vibration {public ushort Left,Right;}
  [DllImport("xinput1_4.dll",EntryPoint="XInputSetState")]static extern uint XSet(uint index,ref Vibration value);
  [StructLayout(LayoutKind.Sequential)] struct Battery {public byte Type,Level;}
  [StructLayout(LayoutKind.Sequential)] struct PadState {public uint Packet;public Pad Pad;}
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Entry {public uint Size,Usage,Pid;public UIntPtr Heap;public uint Module,Threads,Parent;public int Priority;public uint Flags;[MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)]public string Name;}
  delegate bool EnumProc(IntPtr hwnd,IntPtr param);
  [DllImport("xinput1_4.dll",EntryPoint="XInputGetState")]static extern uint XInput(uint index,out PadState state);
  [DllImport("xinput1_4.dll",EntryPoint="XInputGetBatteryInformation")]static extern uint XBattery(uint index,byte device,out Battery battery);
  [DllImport("user32.dll")]static extern bool PostMessage(IntPtr hwnd,uint msg,IntPtr first,IntPtr second);
  [DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
  [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32.dll")]static extern bool EnumWindows(EnumProc callback,IntPtr param);
  [DllImport("user32.dll")]static extern bool EnumChildWindows(IntPtr hwnd,EnumProc callback,IntPtr param);
  [DllImport("user32.dll")]static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")]static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")]static extern bool ShowWindow(IntPtr hwnd,int command);
  [DllImport("user32.dll")]static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")]static extern bool AttachThreadInput(uint first,uint second,bool attach);
  [DllImport("user32.dll")]static extern bool SetWindowPos(IntPtr hwnd,IntPtr after,int x,int y,int w,int h,uint flags);
  [DllImport("kernel32.dll")]static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")]static extern bool GetProcessTimes(IntPtr handle,out long created,out long exited,out long kernel,out long user);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern bool QueryFullProcessImageName(IntPtr process,int flags,StringBuilder name,ref int length);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern int GetApplicationUserModelId(IntPtr process,ref uint length,StringBuilder id);
  [DllImport("kernel32.dll")]static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,EntryPoint="Process32FirstW")]static extern bool ProcessFirst(IntPtr snapshot,ref Entry entry);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,EntryPoint="Process32NextW")]static extern bool ProcessNext(IntPtr snapshot,ref Entry entry);
  [StructLayout(LayoutKind.Sequential)] struct MouseInput {public int X,Y;public uint Data,Flags,Time;public UIntPtr Extra;}
  [StructLayout(LayoutKind.Sequential)] struct KeyInput {public ushort Key,Scan;public uint Flags,Time;public UIntPtr Extra;}
  [StructLayout(LayoutKind.Explicit)] struct InputUnion {[FieldOffset(0)]public MouseInput Mouse;[FieldOffset(0)]public KeyInput Key;}
  [StructLayout(LayoutKind.Sequential)] struct Input {public uint Type;public InputUnion Data;}
  [DllImport("user32.dll")]static extern uint SendInput(uint count,Input[] inputs,int size);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetClassName(IntPtr hwnd,StringBuilder name,int count);
  [DllImport("user32.dll")]static extern IntPtr GetWindow(IntPtr hwnd,uint command);
  static bool OwnDialog(IntPtr target){
   if(Pid(target)!=NovaPid)return false;
   StringBuilder name=new StringBuilder(256);GetClassName(target,name,name.Capacity);if(name.ToString()!="#32770")return false;
   IntPtr owner=target;for(int i=0;i<8;i++){owner=GetWindow(owner,4);if(owner==Dashboard||owner==Guide&&Guide!=IntPtr.Zero)return true;if(owner==IntPtr.Zero)break;}return false;
  }
  static Input Key(ushort code,bool up){Input input=new Input();input.Type=1;input.Data.Key.Key=code;input.Data.Key.Flags=up?2u:0u;return input;}
  static void DialogAction(string action,IntPtr target){
   if(GetForegroundWindow()!=target||!OwnDialog(target))return;
   ushort key=action=="up"?(ushort)0x26:action=="down"?(ushort)0x28:action=="left"?(ushort)0x25:action=="right"?(ushort)0x27:action=="select"?(ushort)0x0D:action=="back"||action=="menu"?(ushort)0x1B:action=="prev"||action=="next"?(ushort)0x09:(ushort)0;
   if(key==0)return;Input[] inputs=action=="prev"?new Input[]{Key(0x10,false),Key(key,false),Key(key,true),Key(0x10,true)}:new Input[]{Key(key,false),Key(key,true)};SendInput((uint)inputs.Length,inputs,Marshal.SizeOf(typeof(Input)));
  }
  static readonly ConcurrentQueue<string> Queue=new ConcurrentQueue<string>();
  static readonly Dictionary<uint,string> Paths=new Dictionary<uint,string>();
  static readonly Dictionary<uint,string> AppIds=new Dictionary<uint,string>();
  static readonly HashSet<uint> Descendants=new HashSet<uint>();
  static readonly Dictionary<uint,long> Births=new Dictionary<uint,long>();
  static readonly HashSet<string> Ignored=new HashSet<string>(StringComparer.OrdinalIgnoreCase){"steam.exe","steamwebhelper.exe","epicgameslauncher.exe","eadesktop.exe","ealauncher.exe","origin.exe","galaxyclient.exe","battle.net.exe","ubisoftconnect.exe","upc.exe","crashpad_handler.exe","crashreportclient.exe","werfault.exe","conhost.exe","explorer.exe","msedge.exe","chrome.exe","firefox.exe","powershell.exe"};
  static IntPtr Dashboard,GameWindow,PreviousWindow,Guide,LastInputWindow,ExitForeground;
  static uint NovaPid,RootPid,PreviousPid,GamePid;
  static string Id="",Kind="",Target="",Directory="";
  static bool Stopping,Observed,ReportedRunning,ReportedResume,DesktopOpen,ComboLatched,ConsoleEnabled,OverlayEnabled=true,Suspended,MediaActive;
  static bool SawGameInForeground,GameWasForeground;
  static int Deadzone=35,Repeat=160,GuideEpoch;
  static long InputGuard,LastPadReport,LastAudio,LastPadActivity,LastIdleReport,RumbleUntil,LastRumble;
  static uint RumbleIndex; static bool Feedback;
  static void StopRumble(){if(RumbleUntil==0)return;Vibration v=new Vibration();try{XSet(RumbleIndex,ref v);}catch{}RumbleUntil=0;}
  static void Pulse(){long now=Clock.ElapsedMilliseconds;if(!Feedback||!Connected||now-LastRumble<100||Suspended)return;StopRumble();Vibration v=new Vibration();v.Left=3500;v.Right=1800;RumbleIndex=SelectedIndex;try{XSet(RumbleIndex,ref v);RumbleUntil=now+30;LastRumble=now;}catch{}}
  static uint SelectedIndex;
  static ushort PreviousButtons;
  static bool PadSeeded,Connected;
  static string LastDirection="";static long NextDirection;
  static long Began,MissingSince,ComboSince;
  static Stopwatch Clock;
  static void Emit(string json){Console.Out.WriteLine(json);Console.Out.Flush();}
  static uint Pid(IntPtr window){uint pid;GetWindowThreadProcessId(window,out pid);return pid;}
  static long Born(uint pid){IntPtr handle=OpenProcess(0x1000,false,pid);if(handle==IntPtr.Zero)return 0;try{long created,exited,kernel,user;return GetProcessTimes(handle,out created,out exited,out kernel,out user)?created:0;}finally{CloseHandle(handle);}}
  static string ProcessPath(uint pid){
   string cached;if(Paths.TryGetValue(pid,out cached))return cached;
   IntPtr process=OpenProcess(0x1000,false,pid);string result="";
   if(process!=IntPtr.Zero){try{StringBuilder text=new StringBuilder(2048);int size=text.Capacity;if(QueryFullProcessImageName(process,0,text,ref size))result=text.ToString();}finally{CloseHandle(process);}}
   Paths[pid]=result;return result;
  }
  static string AppId(uint pid){
   string cached;if(AppIds.TryGetValue(pid,out cached))return cached;
   IntPtr process=OpenProcess(0x1000,false,pid);string result="";
   if(process!=IntPtr.Zero){try{uint size=0;if(GetApplicationUserModelId(process,ref size,null)==122&&size>0&&size<2048){StringBuilder text=new StringBuilder((int)size);if(GetApplicationUserModelId(process,ref size,text)==0)result=text.ToString();}}finally{CloseHandle(process);}}
   AppIds[pid]=result;return result;
  }
  static Dictionary<uint,Entry> Processes(){
   Dictionary<uint,Entry> all=new Dictionary<uint,Entry>();IntPtr snapshot=CreateToolhelp32Snapshot(2,0);
   if(snapshot==new IntPtr(-1))return all;
   try{Entry entry=new Entry();entry.Size=(uint)Marshal.SizeOf(typeof(Entry));if(ProcessFirst(snapshot,ref entry))do{all[entry.Pid]=entry;entry.Size=(uint)Marshal.SizeOf(typeof(Entry));}while(ProcessNext(snapshot,ref entry));}finally{CloseHandle(snapshot);}
   foreach(uint pid in new List<uint>(Paths.Keys))if(!all.ContainsKey(pid))Paths.Remove(pid);
   foreach(uint pid in new List<uint>(AppIds.Keys))if(!all.ContainsKey(pid))AppIds.Remove(pid);
   return all;
  }
  static bool Matches(uint pid,Dictionary<uint,Entry> all){
   Entry entry;if(pid==NovaPid||!all.TryGetValue(pid,out entry)||Ignored.Contains(entry.Name))return false;
   if(Kind=="windows")return String.Equals(AppId(pid),Target,StringComparison.OrdinalIgnoreCase);
   if(Kind=="exe"&&((RootPid>0&&pid==RootPid)||Descendants.Contains(pid)))return true;
   string image=ProcessPath(pid);
   if(Kind=="exe")return image.Length>0&&String.Equals(image,Target,StringComparison.OrdinalIgnoreCase);
   return Kind=="steam"&&Directory.Length>0&&image.StartsWith(Directory.TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase);
  }
  static bool? SteamRunning(){
   if(Kind!="steam")return null;
   foreach(RegistryView view in new RegistryView[]{RegistryView.Registry32,RegistryView.Registry64})try{using(RegistryKey root=RegistryKey.OpenBaseKey(RegistryHive.CurrentUser,view))using(RegistryKey key=root.OpenSubKey("Software\\Valve\\Steam\\Apps\\"+Target)){if(key!=null){object value=key.GetValue("Running");if(value!=null)return Convert.ToInt32(value)!=0;}}}catch{}
   return null;
  }
  static void State(string phase,bool canResume){if(Id.Length==0)return;Emit("{\"type\":\"session\",\"id\":\""+Id+"\",\"phase\":\""+phase+"\",\"canResume\":"+(canResume?"true":"false")+"}");}
  static void Focus(IntPtr window){
   if(window==IntPtr.Zero||!IsWindow(window))return;
   uint ignored;uint other=GetWindowThreadProcessId(GetForegroundWindow(),out ignored),own=GetCurrentThreadId();bool attached=other!=0&&other!=own&&AttachThreadInput(own,other,true);
   try{if(IsIconic(window)||!IsWindowVisible(window))ShowWindow(window,9);SetForegroundWindow(window);}finally{if(attached)AttachThreadInput(own,other,false);}
  }
  static void Home(){
   IntPtr foreground=GetForegroundWindow();uint pid=Pid(foreground);
   if(pid!=NovaPid&&foreground!=IntPtr.Zero){string image=ProcessPath(pid);if(!image.EndsWith("\\explorer.exe",StringComparison.OrdinalIgnoreCase)){PreviousWindow=foreground;PreviousPid=pid;}}
   DesktopOpen=true;Focus(Dashboard);Emit("{\"type\":\"home\"}");
   if(Id.Length>0&&PreviousWindow!=IntPtr.Zero)State(Observed?"running":Kind=="unknown"?"untracked":"starting",true);
  }
  static void OpenGuide(){
   if(Id.Length==0||!OverlayEnabled){Home();return;}
   IntPtr foreground=GetForegroundWindow();uint pid=Pid(foreground);
   if(pid!=NovaPid&&foreground!=IntPtr.Zero){PreviousWindow=foreground;PreviousPid=pid;}
   DesktopOpen=true;
   if(PreviousWindow!=IntPtr.Zero)State(Observed?"running":Kind=="unknown"?"untracked":"starting",true);
   Rect rect;string bounds="";
   if(GetWindowRect(GameWindow!=IntPtr.Zero?GameWindow:foreground,out rect))bounds=",\"bounds\":{\"x\":"+rect.Left+",\"y\":"+rect.Top+",\"width\":"+Math.Max(0,rect.Right-rect.Left)+",\"height\":"+Math.Max(0,rect.Bottom-rect.Top)+"}";
   Emit("{\"type\":\"guide\""+bounds+"}");
  }
  static void InputAction(string action,IntPtr target){Pulse();if(OwnDialog(target)){DialogAction(action,target);return;}Emit("{\"type\":\"input\",\"surface\":\""+(target==Guide?"guide":"dashboard")+"\",\"epoch\":"+(target==Guide?GuideEpoch:0)+",\"action\":\""+action+"\"}");}
  static void Controller(long now){
   PadState state=new PadState();bool connected=false;uint selected=0;
   for(uint offset=0;offset<4;offset++){uint index=(SelectedIndex+offset)%4;PadState candidate;if(XInput(index,out candidate)==0){Pad cp=candidate.Pad;int limit=(int)(32767*Deadzone/100.0);if(cp.Buttons!=0||cp.LT>30||cp.RT>30||Math.Abs((int)cp.LX)>limit||Math.Abs((int)cp.LY)>limit||Math.Abs((int)cp.RX)>limit||Math.Abs((int)cp.RY)>limit)LastPadActivity=now;if(!connected){state=candidate;selected=index;connected=true;}if(candidate.Pad.Buttons!=0||Math.Abs((int)candidate.Pad.LX)>20000||Math.Abs((int)candidate.Pad.LY)>20000){state=candidate;selected=index;break;}}}
   IntPtr target=GetForegroundWindow();bool own=Pid(target)==NovaPid&&(target==Dashboard||target==Guide||OwnDialog(target));
   if(RumbleUntil>0&&(now>=RumbleUntil||!own||Suspended))StopRumble();
   if(now-LastIdleReport>=200){Emit("{\"type\":\"idle\",\"idleMs\":"+Math.Max(0,now-LastPadActivity)+"}");LastIdleReport=now;}
   if(connected!=Connected||now-LastPadReport>(own?100:1000)){
    Battery battery=new Battery();string power="unknown";int level=-1;
    if(connected&&XBattery(selected,0,out battery)==0){power=battery.Type==1?"wired":battery.Type==2||battery.Type==3?"battery":"unknown";if(power=="battery")level=battery.Level;}
    Emit("{\"type\":\"pad\",\"connected\":"+(connected?"true":"false")+",\"index\":"+selected+",\"power\":\""+power+"\",\"battery\":"+level+",\"buttons\":"+(own?state.Pad.Buttons:0)+",\"lx\":"+(own?state.Pad.LX:0)+",\"ly\":"+(own?state.Pad.LY:0)+"}");LastPadReport=now;
   }
   if(connected!=Connected||selected!=SelectedIndex){Connected=connected;PadSeeded=false;}SelectedIndex=selected;
   ushort buttons=connected?state.Pad.Buttons:(ushort)0,pressed=PadSeeded?(ushort)(buttons&~PreviousButtons):(ushort)0;
   bool held=(buttons&0x30)==0x30;
   if((ConsoleEnabled||MediaActive)&&held){if(ComboSince==0)ComboSince=now;if(!ComboLatched&&now-ComboSince>=1000){ComboLatched=true;if(MediaActive)Emit("{\"type\":\"media-home\"}");else OpenGuide();}}
   else if(!held){ComboSince=0;ComboLatched=false;}
   if(target!=LastInputWindow){LastInputWindow=target;InputGuard=now+220;LastDirection="";}
   if(own&&connected&&!held&&now>=InputGuard&&!Suspended){
    Pad p=state.Pad;int threshold=(int)(32767*Deadzone/100.0);
    string direction=(buttons&1)!=0||p.LY>threshold?"up":(buttons&2)!=0||p.LY<-threshold?"down":(buttons&4)!=0||p.LX<-threshold?"left":(buttons&8)!=0||p.LX>threshold?"right":"";
    if(direction.Length==0)LastDirection="";
    else if(direction!=LastDirection||now>=NextDirection){InputAction(direction,target);NextDirection=now+(direction!=LastDirection?330:Repeat);LastDirection=direction;}
    if((pressed&0x1000)!=0)InputAction("select",target);if((pressed&0x2000)!=0)InputAction("back",target);
    if((pressed&0x4000)!=0)InputAction("x",target);if((pressed&0x8000)!=0)InputAction("y",target);
    if((pressed&0x10)!=0)InputAction("menu",target);if((pressed&0x20)!=0)InputAction("home",target);
    if((pressed&0x100)!=0)InputAction("prev",target);if((pressed&0x200)!=0)InputAction("next",target);
   }
   PreviousButtons=buttons;PadSeeded=connected;
   if(Guide!=IntPtr.Zero&&IsWindowVisible(Guide)&&now-LastAudio>3000){Emit(CoreAudio.Apply("get",0));LastAudio=now;}
  }
  static void ResetDashboardInput(){
   DesktopOpen=true;
   Guide=IntPtr.Zero;
   InputGuard=Clock.ElapsedMilliseconds+240;
   PadSeeded=false;
   LastDirection="";
   LastPadReport=0;
   ComboSince=0;
   ComboLatched=true;
  }
  static void Command(string command){
   if(command=="stop"){StopRumble();Stopping=true;return;}
   if(command=="feedback|1"||command=="feedback|0"){Feedback=command=="feedback|1";if(!Feedback)StopRumble();return;}
   if(command=="refresh"){LastPadActivity=Clock.ElapsedMilliseconds;LastPadReport=0;PadSeeded=false;LastInputWindow=IntPtr.Zero;LastDirection="";Paths.Clear();AppIds.Clear();ReportedRunning=false;Observe();return;}
   if(command=="home"){Home();return;}
   if(command=="dashboard-input"){ResetDashboardInput();return;}
   if(command=="main"){DesktopOpen=true;Focus(Dashboard);return;}
   if(command=="guide"){OpenGuide();return;}
   if(command=="media-active|1"||command=="media-active|0"){MediaActive=command=="media-active|1";return;}
   if(command=="guide-hide"){Guide=IntPtr.Zero;DesktopOpen=GetForegroundWindow()==Dashboard;return;}
   if(command=="suspend|1"||command=="suspend|0"){Suspended=command=="suspend|1";StopRumble();LastPadActivity=Clock.ElapsedMilliseconds;PadSeeded=false;return;}
   string[] config=command.Split('|');
   if(config.Length==5&&config[0]=="config"){int deadzone,repeat;if(Int32.TryParse(config[3],out deadzone)&&Int32.TryParse(config[4],out repeat)){ConsoleEnabled=config[1]=="1";OverlayEnabled=config[2]=="1";Deadzone=Math.Max(20,Math.Min(70,deadzone));Repeat=Math.Max(100,Math.Min(300,repeat));}return;}
   if(config.Length==3&&config[0]=="guide-window"){long handle;int epoch;if(Int64.TryParse(config[1],out handle)&&Int32.TryParse(config[2],out epoch)){IntPtr window=new IntPtr(handle);if(IsWindow(window)&&Pid(window)==NovaPid){Guide=window;GuideEpoch=epoch;InputGuard=Clock.ElapsedMilliseconds+250;Focus(Guide);Emit(CoreAudio.Apply("get",0));}}return;}
   if(config.Length>=2&&config[0]=="audio") {int value=0;if(config[1]=="get"||(config.Length==3&&Int32.TryParse(config[2],out value)&&(config[1]=="set"&&value>=0&&value<=100||config[1]=="mute"&&(value==0||value==1))))Emit(CoreAudio.Apply(config[1],value));return;}
   if(command=="resume"||command.StartsWith("resume|",StringComparison.Ordinal)){
    string request=command.IndexOf('|')>=0?command.Substring(command.IndexOf('|')+1):"0";int requestId;if(!Int32.TryParse(request,out requestId))return;
    IntPtr target=GameWindow!=IntPtr.Zero&&IsWindow(GameWindow)&&Pid(GameWindow)==GamePid?GameWindow:PreviousWindow;
    if(target==PreviousWindow&&Pid(target)!=PreviousPid)target=IntPtr.Zero;
    bool success=false;
    if(target!=IntPtr.Zero&&IsWindow(target)){Focus(target);success=GetForegroundWindow()==target;if(success)DesktopOpen=false;}
    Emit("{\"type\":\"resumed\",\"request\":"+requestId+",\"ok\":"+(success?"true":"false")+"}");return;
   }
   if(command.StartsWith("close-game|",StringComparison.Ordinal)){
    string[] parts=command.Split('|');int request;bool ok=false;
    if(parts.Length!=3||!Int32.TryParse(parts[1],out request))return;
    if(parts[2]==Id&&Kind!="unknown"&&GameWindow!=IntPtr.Zero&&IsWindow(GameWindow)&&Pid(GameWindow)==GamePid&&Matches(GamePid,Processes()))ok=PostMessage(GameWindow,0x10,IntPtr.Zero,IntPtr.Zero);
    Emit("{\"type\":\"game-close-requested\",\"request\":"+request+",\"ok\":"+(ok?"true":"false")+"}");return;
   }
   if(command=="clear"){Id="";Kind="";GameWindow=IntPtr.Zero;return;}
   string[] fields=command.Split('|');
   if(fields.Length==5&&fields[0]=="watch"){
    Guid guid;if(!Guid.TryParse(fields[1],out guid))return;
    if(fields[2]!="exe"&&fields[2]!="steam"&&fields[2]!="windows"&&fields[2]!="unknown")return;
    Id=guid.ToString();Kind=fields[2];Target=Encoding.UTF8.GetString(Convert.FromBase64String(fields[3]));Directory=Encoding.UTF8.GetString(Convert.FromBase64String(fields[4]));
    if(Target.Length>2000||Directory.Length>2000){Id="";return;}
    if(Kind=="steam"){ulong appId;if(!UInt64.TryParse(Target,out appId)){Id="";return;}}
    RootPid=0;Descendants.Clear();Births.Clear();Paths.Clear();AppIds.Clear();GameWindow=IntPtr.Zero;PreviousWindow=IntPtr.Zero;PreviousPid=0;Observed=false;ReportedRunning=false;ReportedResume=false;DesktopOpen=false;Began=Clock.ElapsedMilliseconds;MissingSince=0;
    SawGameInForeground=false;GameWasForeground=false;ExitForeground=IntPtr.Zero;
    if(Kind=="unknown")State("untracked",false);else Observe();
    Emit("{\"type\":\"watching\",\"id\":\""+Id+"\"}");
   }else if(fields.Length==3&&fields[0]=="attach"&&fields[1]==Id){uint pid;if(UInt32.TryParse(fields[2],out pid)&&pid!=NovaPid){RootPid=pid;Descendants.Add(pid);Births[pid]=Born(pid);}}
  }
  static void Observe(){
   if(Id.Length==0||Kind=="unknown")return;
   Dictionary<uint,Entry> all=Processes();
   if(all.Count==0)return;
   if(Kind=="exe"){
    foreach(uint pid in new List<uint>(Descendants)){
     long birth;Births.TryGetValue(pid,out birth);long current=all.ContainsKey(pid)?Born(pid):0;
     if((!all.ContainsKey(pid)&&Clock.ElapsedMilliseconds-Began>5000)||(birth>0&&current>0&&birth!=current)){Descendants.Remove(pid);Births.Remove(pid);Paths.Remove(pid);if(RootPid==pid)RootPid=0;}
    }
    for(int pass=0;pass<5;pass++){bool added=false;foreach(Entry e in all.Values)if(Descendants.Contains(e.Parent)&&!Descendants.Contains(e.Pid)){Descendants.Add(e.Pid);Births[e.Pid]=Born(e.Pid);added=true;}if(!added)break;}
   }
   List<IntPtr> windows=new List<IntPtr>();bool processAlive=false;
   foreach(uint pid in all.Keys)if(Matches(pid,all)){processAlive=true;break;}
   EnumWindows(delegate(IntPtr window,IntPtr _){if(!IsWindowVisible(window)||Pid(window)==NovaPid)return true;bool match=Matches(Pid(window),all);if(!match&&Kind=="windows")EnumChildWindows(window,delegate(IntPtr child,IntPtr unused){if(Matches(Pid(child),all)){match=true;return false;}return true;},IntPtr.Zero);if(match)windows.Add(window);return true;},IntPtr.Zero);
   IntPtr active=GetForegroundWindow();
   bool foregroundGame=windows.Contains(active)&&!IsIconic(active);
   bool lastWindowExists=GameWindow!=IntPtr.Zero&&IsWindow(GameWindow)&&Pid(GameWindow)==GamePid;
   // A launcher or Steam registry flag can outlive the actual game window.
   // Use process-only signals until a game window has been used in the foreground.
   bool running=windows.Count>0||(SawGameInForeground?lastWindowExists:Kind=="steam"?(SteamRunning()??processAlive):Kind=="exe"&&processAlive);
   if(running){
    Observed=true;MissingSince=0;
    SawGameInForeground|=foregroundGame;
    GameWasForeground=foregroundGame;
    if(windows.Count>0){GameWindow=windows.Contains(active)?active:windows[0];GamePid=Pid(GameWindow);}
    bool resume=GameWindow!=IntPtr.Zero&&IsWindow(GameWindow);
    if(!ReportedRunning||ReportedResume!=resume){State("running",resume);ReportedRunning=true;ReportedResume=resume;}
    Emit("{\"type\":\"activity\",\"id\":\""+Id+"\",\"active\":"+(!Suspended&&foregroundGame?"true":"false")+"}");
    if(ConsoleEnabled&&!DesktopOpen&&foregroundGame&&Pid(Dashboard)==NovaPid)SetWindowPos(Dashboard,active,0,0,0,0,0x0001|0x0002|0x0010);
   }else if(Observed){
    Emit("{\"type\":\"activity\",\"id\":\""+Id+"\",\"active\":false}");
    long now=Clock.ElapsedMilliseconds;
    if(MissingSince==0){MissingSince=now;ExitForeground=active;}
    if(now-MissingSince>2500){
     uint pid=Pid(active);
     // Windows promotes the next window as soon as a foreground game closes.
     // If the user switches to a different app during the grace period, leave it focused.
     bool returnedByWindows=GameWasForeground&&active==ExitForeground;
     string image=ProcessPath(pid).ToLowerInvariant();
     bool launcherOrDesktop=image.EndsWith("\\explorer.exe")||image.EndsWith("\\steam.exe")||image.EndsWith("\\epicgameslauncher.exe")||image.EndsWith("\\eadesktop.exe")||image.EndsWith("\\ubisoftconnect.exe")||image.EndsWith("\\galaxyclient.exe")||image.EndsWith("\\battle.net.exe");
     bool returnToMenu=!Suspended&&!MediaActive&&(returnedByWindows||active==IntPtr.Zero||pid==NovaPid||launcherOrDesktop);
     Emit("{\"type\":\"session\",\"id\":\""+Id+"\",\"phase\":\"ended\",\"canResume\":false,\"returnToMenu\":"+(returnToMenu?"true":"false")+"}");
     Id="";GameWindow=IntPtr.Zero;PreviousWindow=IntPtr.Zero;
    }
   }
   else if(Clock.ElapsedMilliseconds-Began>120000){State("untracked",false);Kind="unknown";}
  }
  public static void Run(string handle,int novaPid){
   long pointer;if(!Int64.TryParse(handle,out pointer))return;Dashboard=new IntPtr(pointer);NovaPid=(uint)novaPid;
   if(!IsWindow(Dashboard)||Pid(Dashboard)!=NovaPid)return;
   Console.InputEncoding=Encoding.UTF8;Console.OutputEncoding=Encoding.UTF8;Clock=Stopwatch.StartNew();
   Task.Run(delegate{try{string line;while((line=Console.ReadLine())!=null)Queue.Enqueue(line);}catch{}Queue.Enqueue("stop");});
   Emit("{\"type\":\"ready\"}");long lastScan=0;
   try{while(!Stopping&&IsWindow(Dashboard)){
    string command;while(Queue.TryDequeue(out command))try{Command(command);}catch{}
    long now=Clock.ElapsedMilliseconds;Controller(now);
    if(now-lastScan>=500){Observe();lastScan=now;}Thread.Sleep(20);
   }}catch{Emit("{\"type\":\"error\",\"message\":\"Az automatikus visszatérés megállt. A Ctrl+Alt+N gyorsbillentyűvel visszahívhatod a NOVA-t.\"}");}finally{StopRumble();}
  }
 }
}
