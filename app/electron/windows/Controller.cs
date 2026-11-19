// Windows C# 5. Input polling never waits for WMI or UI Automation.
// Mouse/keyboard events target only a verified window from NOVA's dedicated Edge profile.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Automation;
namespace Nova {
 public static class MediaController {
  [StructLayout(LayoutKind.Sequential)]struct Gamepad {public ushort Buttons;public byte LT,RT;public short LX,LY,RX,RY;}
  [StructLayout(LayoutKind.Sequential)]struct PadState {public uint Packet;public Gamepad Pad;}
  [StructLayout(LayoutKind.Sequential)]struct Point {public int X,Y;}
  [StructLayout(LayoutKind.Sequential)]struct Rect {public int Left,Top,Right,Bottom;}
  [StructLayout(LayoutKind.Sequential)]struct MouseInput {public int X,Y;public uint Data,Flags,Time;public UIntPtr Extra;}
  [StructLayout(LayoutKind.Sequential)]struct KeyInput {public ushort Key,Scan;public uint Flags,Time;public UIntPtr Extra;}
  [StructLayout(LayoutKind.Explicit)]struct InputUnion {[FieldOffset(0)]public MouseInput Mouse;[FieldOffset(0)]public KeyInput Key;}
  [StructLayout(LayoutKind.Sequential)]struct Input {public uint Type;public InputUnion Data;}
  delegate bool EnumProc(IntPtr hwnd,IntPtr param);
  [DllImport("xinput1_4.dll",EntryPoint="XInputGetState")]static extern uint XInput(uint index,out PadState state);
  [DllImport("user32.dll")]static extern uint SendInput(uint count,Input[] inputs,int size);
  [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32.dll")]static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")]static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")]static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")]static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
  [DllImport("user32.dll")]static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")]static extern IntPtr GetAncestor(IntPtr hwnd,uint flag);
  [DllImport("user32.dll")]static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")]static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")]static extern bool EnumWindows(EnumProc callback,IntPtr param);
  [DllImport("user32.dll")]static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")]static extern bool BringWindowToTop(IntPtr hwnd);
  [DllImport("user32.dll")]static extern bool SetWindowPos(IntPtr hwnd,IntPtr after,int x,int y,int w,int h,uint flags);
  [DllImport("user32.dll")]static extern bool ShowWindow(IntPtr hwnd,int command);
  [DllImport("user32.dll")]static extern bool AttachThreadInput(uint first,uint second,bool attach);
  [DllImport("kernel32.dll")]static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")]static extern bool PostMessage(IntPtr hwnd,uint msg,IntPtr first,IntPtr second);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetClassName(IntPtr hwnd,StringBuilder name,int count);
  [DllImport("shell32.dll",CharSet=CharSet.Unicode)]static extern IntPtr CommandLineToArgvW(string command,out int count);
  [DllImport("kernel32.dll")]static extern IntPtr LocalFree(IntPtr memory);
  const ushort A=0x1000,B=0x2000,X=0x4000,Y=0x8000,Menu=0x10,View=0x20,LB=0x100,RB=0x200,Up=1,Down=2,Left=4,Right=8,LStick=0x40,RStick=0x80;
  static int NovaPid,OverlaySession,Deadzone=35,Repeat=160,Epoch,UiaBusy,Typing;
  static IntPtr Dashboard,Overlay,Browser,EditWindow,Hud;
  static string OverlayView="toolbar",Profile,EdgeRoot;
  static volatile string LastEdit="";
  static volatile bool Stopping,Paused=true,AutoKeyboard=true;
  static bool MouseHeld,Connected,AutoTimedOut,ClosingBrowser,CloseObserved;
  static long CloseBegan,CloseEmptySince,CloseLastPost;
  static readonly object OutputLock=new object(),WindowsLock=new object(),ContextLock=new object();
  static HashSet<int> Approved=new HashSet<int>();
  static readonly ConcurrentQueue<string> Commands=new ConcurrentQueue<string>();
  static Stopwatch Clock;
  static readonly MediaNavigation Navigation=new MediaNavigation();
  static void NavigationChanged(){Emit("{\"type\":\"navigation\",\"mode\":\""+Navigation.Mode+"\",\"speed\":\""+Navigation.Speed+"\"}");}
  static void CenterPointer(){Rect r;if(GetWindowRect(Browser,out r))SetCursorPos(r.Left+(r.Right-r.Left)/2,r.Top+(r.Bottom-r.Top)/2);}
  static long UiaBegan,RelayAt=-10000;static Gamepad RelayPad;static uint Selected;
  static void Emit(string json){lock(OutputLock){Console.Out.WriteLine(json);Console.Out.Flush();}}
  static void Error(string message){Emit("{\"type\":\"error\",\"message\":\""+message+"\"}");}
  static uint Pid(IntPtr window){uint pid;GetWindowThreadProcessId(window,out pid);return pid;}
  static bool NovaWindow(IntPtr window){return window!=IntPtr.Zero&&IsWindow(window)&&Pid(window)==(uint)NovaPid;}
  static bool OwnWindow(IntPtr window){if(window==IntPtr.Zero||!IsWindow(window))return false;lock(WindowsLock)return Approved.Contains((int)Pid(window));}
  static bool Active(){return OwnWindow(GetForegroundWindow());}
  static bool OverlayActive(){return NovaWindow(Overlay)&&IsWindowVisible(Overlay)&&(GetForegroundWindow()==Overlay||Active());}
  static bool FocusWindow(IntPtr window){
   if(window==IntPtr.Zero||!IsWindow(window))return false;
   uint ignored,other=GetWindowThreadProcessId(GetForegroundWindow(),out ignored),own=GetCurrentThreadId();bool attached=other!=0&&other!=own&&AttachThreadInput(own,other,true);
   try{if(IsIconic(window))ShowWindow(window,9);BringWindowToTop(window);SetForegroundWindow(window);}finally{if(attached)AttachThreadInput(own,other,false);}return GetForegroundWindow()==window;
  }
  static IntPtr FindWindow(){
   IntPtr active=GetForegroundWindow();if(OwnWindow(active)&&IsWindowVisible(active))return active;
   IntPtr found=IntPtr.Zero;long largest=0;
   EnumWindows(delegate(IntPtr window,IntPtr unused){if(!OwnWindow(window)||!IsWindowVisible(window))return true;StringBuilder name=new StringBuilder(128);GetClassName(window,name,name.Capacity);if(!name.ToString().StartsWith("Chrome_WidgetWin",StringComparison.Ordinal))return true;Rect rect;if(GetWindowRect(window,out rect)){long area=(long)(rect.Right-rect.Left)*(rect.Bottom-rect.Top);if(area>largest){largest=area;found=window;}}return true;},IntPtr.Zero);return found;
  }
  static bool ProfileMatches(string command){
   if(String.IsNullOrEmpty(command))return false;int count;IntPtr memory=CommandLineToArgvW(command,out count);if(memory==IntPtr.Zero)return false;bool matches=false;
   try{for(int i=0;i<count;i++){string arg=Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory,i*IntPtr.Size));if(arg.StartsWith("--type=",StringComparison.OrdinalIgnoreCase))return false;if(arg.StartsWith("--user-data-dir=",StringComparison.OrdinalIgnoreCase)){try{matches=String.Equals(Path.GetFullPath(arg.Substring(16)).TrimEnd('\\'),Profile,StringComparison.OrdinalIgnoreCase);}catch{return false;}}}return matches;}finally{LocalFree(memory);}
  }
  static void Discover(){
   while(!Stopping&&NovaWindow(Dashboard)){
    try{
     HashSet<int> next=new HashSet<int>();Dictionary<int,int> parents=new Dictionary<int,int>();EnumerationOptions options=new EnumerationOptions();options.Timeout=TimeSpan.FromSeconds(2);options.ReturnImmediately=true;
     using(ManagementObjectSearcher search=new ManagementObjectSearcher("root\\CIMV2","SELECT ProcessId,ParentProcessId,ExecutablePath,CommandLine FROM Win32_Process WHERE Name='msedge.exe'",options))
     using(ManagementObjectCollection rows=search.Get())foreach(ManagementObject row in rows)using(row){int id=Convert.ToInt32(row["ProcessId"]);string image=row["ExecutablePath"] as string,command=row["CommandLine"] as string;
      if(String.IsNullOrEmpty(image))try{image=Process.GetProcessById(id).MainModule.FileName;}catch{}
      if(!String.IsNullOrEmpty(image)&&image.StartsWith(EdgeRoot+"\\",StringComparison.OrdinalIgnoreCase)&&String.Equals(Path.GetFileName(image),"msedge.exe",StringComparison.OrdinalIgnoreCase)){parents[id]=Convert.ToInt32(row["ParentProcessId"]);if(ProfileMatches(command))next.Add(id);}}
     for(int pass=0;pass<8;pass++){bool changed=false;foreach(KeyValuePair<int,int> pair in parents)if(next.Contains(pair.Value)&&next.Add(pair.Key))changed=true;if(!changed)break;}
     lock(WindowsLock)Approved=next;
    }catch{Emit("{\"type\":\"discovery-warning\"}");}
    for(int i=0;i<10&&!Stopping;i++)Thread.Sleep(100);
   }
  }
  static Input Key(ushort code,bool up){Input input=new Input();input.Type=1;input.Data.Key.Key=code;input.Data.Key.Flags=up?2u:0u;return input;}
  static Input Unicode(char c,bool up){Input input=new Input();input.Type=1;input.Data.Key.Scan=c;input.Data.Key.Flags=4u|(up?2u:0u);return input;}
  static Input Mouse(uint flags,int data){Input input=new Input();input.Data.Mouse.Flags=flags;input.Data.Mouse.Data=unchecked((uint)data);return input;}
  static bool Inject(params Input[] inputs){return SendInput((uint)inputs.Length,inputs,Marshal.SizeOf(typeof(Input)))==(uint)inputs.Length;}
  static void ClickKey(ushort key){Inject(Key(key,false),Key(key,true));}
  static void Chord(ushort mod,ushort key){Inject(Key(mod,false),Key(key,false),Key(key,true),Key(mod,true));}
  static void ReleaseMouse(){if(MouseHeld){Inject(Mouse(4,0));MouseHeld=false;}}
  static bool FocusBrowser(){
   Browser=FindWindow();if(!OwnWindow(Browser)||!FocusWindow(Browser))return false;
   // Only NOVA's own backdrop moves behind the verified Edge profile window.
   // NOSIZE | NOMOVE | NOACTIVATE: this must not re-activate the dashboard.
   if(NovaWindow(Dashboard))SetWindowPos(Dashboard,Browser,0,0,0,0,0x0001|0x0002|0x0010);
   return GetForegroundWindow()==Browser;
  }
  static bool ServiceUrl(string url){return url=="https://www.disneyplus.com/"||url=="https://www.youtube.com/"||url=="https://www.hbomax.com/"||url=="https://open.spotify.com/"||url=="edge://settings/help"||url=="edge://settings/content/protectedContent"||url=="edge://settings/system";}
  static void ActivationResult(int request,bool ok,string reason){Emit("{\"type\":\"activation\",\"request\":"+request+",\"ok\":"+(ok?"true":"false")+",\"reason\":\""+reason+"\"}");}
  static void Activate(string line){
   string[] parts=line.Split('|');int request;if(parts.Length<3||!Int32.TryParse(parts[1],out request)||request<=0)return;
   string url=null;
   if(parts[2]=="navigate"&&parts.Length==4){try{url=Encoding.UTF8.GetString(Convert.FromBase64String(parts[3]));}catch{return;}if(!ServiceUrl(url))return;}
   else if(parts.Length!=3||(parts[2]!="resume"&&parts[2]!="keyboard"&&parts[2]!="back"&&parts[2]!="forward"&&parts[2]!="refresh"&&parts[2]!="fullscreen"&&parts[2]!="playpause"&&parts[2]!="escape"&&parts[2]!="space"))return;
   Browser=FindWindow();if(!OwnWindow(Browser)){ActivationResult(request,false,"missing");return;}
   IntPtr foreground=GetForegroundWindow();StringBuilder className=new StringBuilder(64);GetClassName(foreground,className,className.Capacity);
   if(foreground!=IntPtr.Zero&&!NovaWindow(foreground)&&!OwnWindow(foreground)&&className.ToString()!="Progman"&&className.ToString()!="WorkerW") {ActivationResult(request,false,"cancelled");return;}
   ReleaseMouse();lock(ContextLock){Epoch++;Paused=true;EditWindow=IntPtr.Zero;Overlay=IntPtr.Zero;}
   if(!FocusBrowser()){ActivationResult(request,false,"blocked");return;}
   if(url!=null){Chord(0x11,0x4C);foreach(char c in url){if(!Active()){ActivationResult(request,false,"cancelled");return;}Inject(Unicode(c,false),Unicode(c,true));}ClickKey(0x0D);}
   if(!PointerOnBrowser())CenterPointer();
   if(parts[2]=="space")ClickKey(0x20);else if(parts[2]=="escape")ClickKey(0x1B);else if(parts[2]=="back")Chord(0x12,0x25);else if(parts[2]=="forward")Chord(0x12,0x27);else if(parts[2]=="refresh")ClickKey(0x74);else if(parts[2]=="fullscreen")ClickKey(0x7A);else if(parts[2]=="playpause")ClickKey(0xB3);
   Paused=false;ActivationResult(request,true,"focused");if(parts[2]=="keyboard")InspectField(true);
  }
  static void Home(){ReleaseMouse();lock(ContextLock){Epoch++;Paused=true;EditWindow=IntPtr.Zero;Overlay=IntPtr.Zero;}Emit("{\"type\":\"home\"}");}
  static void UI(string action){Emit("{\"type\":\"ui\",\"session\":"+OverlaySession+",\"action\":\""+action+"\"}");}
  static bool PointerOnBrowser(){Point p;GetCursorPos(out p);IntPtr root=GetAncestor(WindowFromPoint(p),2);if(OwnWindow(root))return true;Rect r;return root==Hud&&NovaWindow(Hud)&&Active()&&GetWindowRect(Browser,out r)&&p.X>=r.Left&&p.X<r.Right&&p.Y>=r.Top&&p.Y<r.Bottom;}
  static double Axis(short value){double n=Math.Max(-1,Math.Min(1,value/32767.0)),a=Math.Abs(n),d=Deadzone/100.0;return a<d?0:Math.Sign(n)*Math.Pow((a-d)/(1-d),1.5);}
  static void Move(int dx,int dy){Point p;Rect rect;GetCursorPos(out p);if(!GetWindowRect(Browser,out rect)||rect.Right-rect.Left<20||rect.Bottom-rect.Top<20)return;SetCursorPos(Math.Max(rect.Left+5,Math.Min(rect.Right-6,p.X+dx)),Math.Max(rect.Top+5,Math.Min(rect.Bottom-6,p.Y+dy)));}
  static bool ReadPad(out Gamepad pad,out bool relay){
   PadState state;bool found=false;Gamepad first=new Gamepad();uint firstIndex=Selected;
   for(uint offset=0;offset<4;offset++){uint index=(Selected+offset)%4;if(XInput(index,out state)==0){if(!found){first=state.Pad;firstIndex=index;found=true;}if(state.Pad.Buttons!=0||Math.Abs((int)state.Pad.LX)>12000||Math.Abs((int)state.Pad.LY)>12000||Math.Abs((int)state.Pad.RY)>12000||state.Pad.LT>60||state.Pad.RT>60){Selected=index;pad=state.Pad;relay=false;return true;}}}
   bool relayFresh=Clock.ElapsedMilliseconds-RelayAt<250;
   if(relayFresh&&(!found||RelayPad.Buttons!=0||Math.Abs((int)RelayPad.LX)>12000||Math.Abs((int)RelayPad.LY)>12000||Math.Abs((int)RelayPad.RY)>12000||RelayPad.LT>60||RelayPad.RT>60)){pad=RelayPad;relay=true;return true;}
   if(found){Selected=firstIndex;pad=first;relay=false;return true;}
   if(relayFresh){pad=RelayPad;relay=true;return true;}pad=new Gamepad();relay=false;return false;
  }
  static void InspectField(bool manual){
   if(!Active())return;IntPtr window=GetForegroundWindow();int epoch=Epoch;
   if(manual){ReleaseMouse();lock(ContextLock){EditWindow=window;Paused=true;}Emit("{\"type\":\"keyboard\",\"password\":true,\"manual\":true}");}
   if(Interlocked.CompareExchange(ref UiaBusy,1,0)!=0)return;UiaBegan=Clock.ElapsedMilliseconds;
   Task.Run(delegate{
    try{
     AutomationElement field=AutomationElement.FocusedElement;if(field==null)return;
     ControlType type=field.Current.ControlType;bool enabled=field.Current.IsEnabled,password=field.Current.IsPassword;int process=field.Current.ProcessId;
     if(process==NovaPid||!enabled||(type!=ControlType.Edit&&type!=ControlType.ComboBox))return;
     // Never auto-open over the Edge address bar: only fields inside web documents.
     AutomationElement ancestor=field;bool inDocument=false;
     for(int depth=0;depth<14&&ancestor!=null;depth++){if(ancestor.Current.ControlType==ControlType.Document){inDocument=true;break;}ancestor=TreeWalker.ControlViewWalker.GetParent(ancestor);}
     if(!inDocument)return;
     object pattern;if(field.TryGetCurrentPattern(ValuePattern.Pattern,out pattern)&&((ValuePattern)pattern).Current.IsReadOnly)return;
     string id=String.Join(".",Array.ConvertAll(field.GetRuntimeId(),delegate(int n){return n.ToString();}));
     lock(ContextLock){
      if(epoch!=Epoch||!OwnWindow(window))return;
      if(manual){if(GetForegroundWindow()!=window&&!OverlayActive())return;}
      else if(!AutoKeyboard||Paused||GetForegroundWindow()!=window||id==LastEdit)return;
      LastEdit=id;EditWindow=window;Paused=true;
      Emit("{\"type\":\""+(manual?"keyboard-metadata":"keyboard")+"\",\"password\":"+(password?"true":"false")+",\"manual\":false}");
     }
    }catch{if(manual)Emit("{\"type\":\"uia-warning\"}");}
    finally{Interlocked.Exchange(ref UiaBusy,0);}
   });
  }
  static void TypeText(string command){
   string[] parts=command.Split(new char[]{'|'},4);if(parts.Length!=4||!OwnWindow(EditWindow)){Error("Kattints újra a kívánt szövegmezőbe, majd nyomd meg az X-et.");return;}
   string text;try{text=Encoding.UTF8.GetString(Convert.FromBase64String(parts[3]));}catch{Error("Érvénytelen szövegbevitel.");return;}
   if(text.Length>2000||text.IndexOf('\0')>=0){Error("A szöveg túl hosszú.");return;}
   if(!FocusWindow(EditWindow)){Error("Nem sikerült a böngészőre váltani.");return;}
   if(Interlocked.CompareExchange(ref Typing,1,0)!=0)return;int epoch=Epoch;IntPtr window=EditWindow;Paused=true;
   Task.Run(delegate{try{
    if(Stopping||epoch!=Epoch||GetForegroundWindow()!=window||!OwnWindow(window))return;
    if(parts[1]=="1")Chord(0x11,0x41);
    for(int i=0;i<text.Length;i++){if(Stopping||epoch!=Epoch||GetForegroundWindow()!=window||!OwnWindow(window))return;if(!Inject(Unicode(text[i],false),Unicode(text[i],true)))throw new InvalidOperationException();}
    if(parts[2]=="1"&&epoch==Epoch&&GetForegroundWindow()==window)ClickKey(0x0D);
    if(epoch==Epoch){Paused=false;Emit("{\"type\":\"typed\"}");}
   }catch{Error("A böngésző nem fogadta a bevitelt. Kattints a mezőbe, majd próbáld újra.");}finally{text=null;Interlocked.Exchange(ref Typing,0);}});
  }
  static void Command(string line){
   if(line.StartsWith("activate|",StringComparison.Ordinal)){Activate(line);return;}
   if(line=="stop"){Stopping=true;Interlocked.Increment(ref Epoch);ReleaseMouse();return;}
   if(line=="home"){Home();return;}
   if(line=="pause"){ReleaseMouse();lock(ContextLock){Epoch++;Paused=true;EditWindow=IntPtr.Zero;}return;}
   if(line=="overlay-hide"){Overlay=IntPtr.Zero;return;}
   if(line.StartsWith("mode|",StringComparison.Ordinal)){ReleaseMouse();if(Navigation.SetMode(line.Substring(5)))NavigationChanged();return;}
   if(line.StartsWith("speed|",StringComparison.Ordinal)){if(Navigation.SetSpeed(line.Substring(6)))NavigationChanged();return;}
   if(line=="auto|0"||line=="auto|1"){AutoKeyboard=line=="auto|1";return;}
   if(line.StartsWith("config|",StringComparison.Ordinal)){string[] f=line.Split('|');int d,r;if(f.Length==3&&Int32.TryParse(f[1],out d)&&Int32.TryParse(f[2],out r)){Deadzone=Math.Max(20,Math.Min(70,d));Repeat=Math.Max(100,Math.Min(300,r));}return;}
   if(line.StartsWith("pad|",StringComparison.Ordinal)){string[] f=line.Split('|');ushort buttons;short lx,ly,ry;byte lt,rt;if(f.Length==7&&UInt16.TryParse(f[1],out buttons)&&Int16.TryParse(f[2],out lx)&&Int16.TryParse(f[3],out ly)&&Int16.TryParse(f[4],out ry)&&Byte.TryParse(f[5],out lt)&&Byte.TryParse(f[6],out rt)){RelayPad=new Gamepad{Buttons=buttons,LX=lx,LY=ly,RY=ry,LT=lt,RT=rt};RelayAt=Clock.ElapsedMilliseconds;}return;}
   if(line.StartsWith("overlay|",StringComparison.Ordinal)){string[] f=line.Split('|');long handle;int session;if(f.Length==4&&Int64.TryParse(f[1],out handle)&&Int32.TryParse(f[2],out session)){IntPtr window=new IntPtr(handle);if(session>0&&NovaWindow(window)&&(f[3]=="keyboard"||f[3]=="toolbar")){ReleaseMouse();Paused=true;Overlay=window;OverlaySession=session;OverlayView=f[3];FocusWindow(window);}}return;}
   if(line.StartsWith("text|",StringComparison.Ordinal)){TypeText(line);return;}
   if(line=="resume"){lock(ContextLock){Epoch++;EditWindow=IntPtr.Zero;Paused=false;}FocusBrowser();return;}
   if(line=="keyboard"){if(FocusBrowser())InspectField(true);else Error("A NOVA médiaböngésző ablaka még nem található.");return;}
   if(line.StartsWith("hud|",StringComparison.Ordinal)){long handle;if(Int64.TryParse(line.Substring(4),out handle)&&(handle==0||NovaWindow(new IntPtr(handle))))Hud=new IntPtr(handle);return;}
   if(line.StartsWith("navigate|",StringComparison.Ordinal)){
    string url;try{url=Encoding.UTF8.GetString(Convert.FromBase64String(line.Substring(9)));}catch{return;}
    if(!ServiceUrl(url))return;
    if(FocusBrowser()){Chord(0x11,0x4C);foreach(char c in url){if(!Active())return;Inject(Unicode(c,false),Unicode(c,true));}ClickKey(0x0D);}return;
   }
   if(line=="close"){ReleaseMouse();Paused=true;Interlocked.Increment(ref Epoch);Overlay=IntPtr.Zero;ClosingBrowser=true;CloseObserved=false;CloseBegan=Clock.ElapsedMilliseconds;CloseEmptySince=0;CloseLastPost=-1000;return;}
   if(!FocusBrowser()){Error("A NOVA médiaböngésző ablaka még nem található.");return;}
   if(line=="back")Chord(0x12,0x25);else if(line=="forward")Chord(0x12,0x27);else if(line=="refresh")ClickKey(0x74);else if(line=="fullscreen")ClickKey(0x7A);else if(line=="playpause")ClickKey(0xB3);Paused=false;
  }
  static void CloseBrowserWindows(long now){
   bool found=false;
   EnumWindows(delegate(IntPtr window,IntPtr unused){
    if(!OwnWindow(window)||!IsWindowVisible(window))return true;
    StringBuilder name=new StringBuilder(128);GetClassName(window,name,name.Capacity);
    if(!name.ToString().StartsWith("Chrome_WidgetWin",StringComparison.Ordinal))return true;
    found=true;CloseObserved=true;
    if(now-CloseLastPost>=500)PostMessage(window,0x10,IntPtr.Zero,IntPtr.Zero);
    return true;
   },IntPtr.Zero);
   if(now-CloseLastPost>=500)CloseLastPost=now;
   bool processes;lock(WindowsLock)processes=Approved.Count>0;
   if(processes)CloseObserved=true;
   if(found||processes)CloseEmptySince=0;else if(CloseObserved){
    if(CloseEmptySince==0)CloseEmptySince=now;
    if(now-CloseEmptySince>=400){ClosingBrowser=false;Emit("{\"type\":\"browser-closed\",\"ok\":true}");return;}
   }
   if(now-CloseBegan>7000){ClosingBrowser=false;Emit("{\"type\":\"browser-closed\",\"ok\":false}");}
  }
  public static void Run(int launcherPid,int novaPid,long dashboardHandle,string profile,string browserExe){
   try{SetThreadDpiAwarenessContext(new IntPtr(-4));}catch{}
   // launcherPid is informational: Edge can forward and exit before its real window appears.
   NovaPid=novaPid;Dashboard=new IntPtr(dashboardHandle);Profile=Path.GetFullPath(profile).TrimEnd('\\');EdgeRoot=Path.GetDirectoryName(Path.GetFullPath(browserExe));
   Console.InputEncoding=Encoding.UTF8;Console.OutputEncoding=Encoding.UTF8;Clock=Stopwatch.StartNew();
   Task.Run(delegate{string line;try{while((line=Console.ReadLine())!=null)Commands.Enqueue(line);}catch{}Commands.Enqueue("stop");});Task.Run((Action)Discover);
   Emit("{\"type\":\"helper-ready\"}");long lastTick=0,lastInspect=0,lastWheel=0,lastReport=0;ushort previous=0;bool seeded=false,wasBound=false,everBound=false,reportedActive=false,mouseDown=false;long missingSince=0;double carryX=0,carryY=0;string directionBefore="";long directionAt=0;IntPtr inputWindow=IntPtr.Zero;uint inputPad=99;bool inputRelay=false;long inputAfter=0;
   try{while(!Stopping&&NovaWindow(Dashboard)){
    string line;int limit=0;while(limit++<64&&Commands.TryDequeue(out line))Command(line);if(Stopping)break;
    long now=Clock.ElapsedMilliseconds;if(ClosingBrowser){CloseBrowserWindows(now);Thread.Sleep(12);continue;}Browser=FindWindow();bool bound=Browser!=IntPtr.Zero;
    if(bound&&!wasBound)Emit("{\"type\":\"ready\"}");wasBound=bound;
    if(bound){everBound=true;missingSince=0;}else if(everBound){if(missingSince==0)missingSince=now;if(now-missingSince>5000)break;}
    Gamepad p;bool relay;bool connected=ReadPad(out p,out relay);if(connected!=Connected){Connected=connected;seeded=false;Emit(connected?"{\"type\":\"connected\"}":"{\"type\":\"disconnected\"}");}
    IntPtr currentWindow=GetForegroundWindow();if(currentWindow!=inputWindow||Selected!=inputPad||relay!=inputRelay){inputWindow=currentWindow;inputPad=Selected;inputRelay=relay;inputAfter=now+220;seeded=false;ReleaseMouse();Navigation.Reset();directionBefore="";carryX=0;carryY=0;}
    ushort pressed=seeded?(ushort)(p.Buttons&~previous):(ushort)0;bool overlay=OverlayActive(),browser=Active();
    if(connected&&(browser||overlay)&&(pressed&View)!=0)Home();
    else if(connected&&overlay&&now>=inputAfter){ReleaseMouse();int threshold=(int)(32767*Deadzone/100.0);string d=(p.Buttons&Up)!=0||p.LY>threshold?"up":(p.Buttons&Down)!=0||p.LY<-threshold?"down":(p.Buttons&Left)!=0||p.LX<-threshold?"left":(p.Buttons&Right)!=0||p.LX>threshold?"right":"";
     if(d.Length==0)directionBefore="";else if(d!=directionBefore||now>=directionAt){UI(d);directionAt=now+(d!=directionBefore?330:Repeat);directionBefore=d;}
     if((pressed&A)!=0)UI("select");if((pressed&B)!=0)UI("back");if((pressed&Menu)!=0)UI("menu");if((pressed&X)!=0)UI(OverlayView=="keyboard"?"delete":"keyboard");if((pressed&Y)!=0&&OverlayView=="keyboard")UI("shift");
    }else if(connected&&browser&&now>=inputAfter){
     if((pressed&(Menu|Y))!=0){ReleaseMouse();Paused=true;Emit("{\"type\":\"toolbar\"}");}
     else if((pressed&X)!=0)InspectField(true);
     else if(!Paused&&(pressed&LStick)!=0){ReleaseMouse();Navigation.Cycle();NavigationChanged();carryX=0;carryY=0;}
     else if(!Paused&&(pressed&RStick)!=0){ReleaseMouse();Navigation.SetMode("pointer");CenterPointer();NavigationChanged();carryX=0;carryY=0;}
     else if(!Paused){
      if(Navigation.Mode=="pointer"){
      double dt=Math.Min(.05,Math.Max(.001,(now-lastTick)/1000.0)),vx=Axis(p.LX),vy=-Axis(p.LY);if((p.Buttons&Left)!=0)vx=-.22;if((p.Buttons&Right)!=0)vx=.22;if((p.Buttons&Up)!=0)vy=-.22;if((p.Buttons&Down)!=0)vy=.22;
      double dx=vx*1150*Navigation.SpeedFactor*dt+carryX,dy=vy*1150*Navigation.SpeedFactor*dt+carryY;int mx=(int)dx,my=(int)dy;carryX=dx-mx;carryY=dy-my;if(mx!=0||my!=0)Move(mx,my);
      if((pressed&A)!=0&&PointerOnBrowser()){LastEdit="";Inject(Mouse(2,0));MouseHeld=true;}if(MouseHeld&&(p.Buttons&A)==0)ReleaseMouse();
      }else{
       ReleaseMouse();string step=Navigation.Step(p.Buttons,p.LX,p.LY,now,Deadzone,Repeat);
       if(step=="previous")Chord(0x10,0x09);else if(step=="next")ClickKey(0x09);else if(step=="left")ClickKey(0x25);else if(step=="up")ClickKey(0x26);else if(step=="right")ClickKey(0x27);else if(step=="down")ClickKey(0x28);
       if((pressed&A)!=0){LastEdit="";ClickKey(0x0D);lastInspect=now;}
      }
      if((pressed&B)!=0)ClickKey(0x1B);if((pressed&LB)!=0)Chord(0x12,0x25);if((pressed&RB)!=0)Chord(0x12,0x27);
      if(now-lastWheel>75){int wheel=(int)(Axis(p.RY)*160);if(p.LT>60)wheel=120;if(p.RT>60)wheel=-120;if(wheel!=0&&Navigation.Mode!="pointer")CenterPointer();if(wheel!=0&&PointerOnBrowser())Inject(Mouse(0x800,wheel));lastWheel=now;}
     }
    }else{ReleaseMouse();carryX=0;carryY=0;}
    if(UiaBusy==0)AutoTimedOut=false;
    if(UiaBusy!=0&&now-UiaBegan>2000&&!AutoTimedOut){AutoTimedOut=true;Emit("{\"type\":\"uia-warning\"}");}
    browser=Active();
    // An editable field can be reached with a physical mouse or keyboard too.
    // Probe after release, so a click or controller drag completes before NOVA takes focus.
    bool physicalClick=browser&&(GetAsyncKeyState(1)&0x8000)!=0;
    if(physicalClick&&!mouseDown&&!Paused&&PointerOnBrowser())LastEdit="";
    mouseDown=physicalClick;
    if(browser&&AutoKeyboard&&!AutoTimedOut&&!Paused&&!MouseHeld&&!mouseDown&&now>=inputAfter&&now-lastInspect>250){
     InspectField(false);lastInspect=now;
    }
    if(browser!=reportedActive||now-lastReport>(browser||overlay?100:1000)){reportedActive=browser;Point cursor;Rect rect;GetCursorPos(out cursor);GetWindowRect(Browser,out rect);Emit("{\"type\":\"status\",\"bound\":"+(bound?"true":"false")+",\"browserActive\":"+(browser?"true":"false")+",\"inputActive\":"+(connected&&(p.Buttons!=0||Math.Abs((int)p.LX)>12000||Math.Abs((int)p.LY)>12000||Math.Abs((int)p.RY)>12000||p.LT>60||p.RT>60)?"true":"false")+",\"paused\":"+(Paused?"true":"false")+",\"source\":\""+(relay?"relay":"xinput")+"\",\"x\":"+cursor.X+",\"y\":"+cursor.Y+",\"bounds\":{\"x\":"+rect.Left+",\"y\":"+rect.Top+",\"width\":"+Math.Max(0,rect.Right-rect.Left)+",\"height\":"+Math.Max(0,rect.Bottom-rect.Top)+"}}");lastReport=now;}
    previous=p.Buttons;seeded=connected;lastTick=now;Thread.Sleep(12);
   }}catch{Error("A médiavezérlő megállt. View + Menü 1 másodpercig: NOVA.");}
   finally{Stopping=true;ReleaseMouse();Emit("{\"type\":\"closed\"}");}
  }
 }
}
