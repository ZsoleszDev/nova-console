// C# 5 / .NET Framework 4.8. Hides the mouse pointer everywhere (NOVA, Windows,
// films, the Parsec picture) while a controller is in use, and brings it back
// as soon as the mouse moves (a real mouse, or Parsec's from the laptop).
// The pointer is hidden by swapping the system cursors for a blank one and is
// restored from the user's own cursor scheme (SPI_SETCURSORS), which is also
// done whenever the helper starts or stops.
using System;
using System.Runtime.InteropServices;
namespace Nova {
 public static class CursorHide {
  [StructLayout(LayoutKind.Sequential)] public struct Point {public int X,Y;}
  [StructLayout(LayoutKind.Sequential)] struct LastInputInfo {public uint Size,Time;}
  [DllImport("user32.dll")]static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")]static extern bool GetLastInputInfo(ref LastInputInfo info);
  [DllImport("user32.dll")]static extern IntPtr CreateCursor(IntPtr instance,int hotX,int hotY,int width,int height,byte[] andPlane,byte[] xorPlane);
  [DllImport("user32.dll")]static extern bool SetSystemCursor(IntPtr cursor,uint id);
  [DllImport("user32.dll")]static extern bool SystemParametersInfo(uint action,uint param,IntPtr value,uint flags);
  // Arrow, I-beam, wait, cross, up, the four sizes, move, no, hand, busy, help, pin, person.
  static readonly uint[] Cursors={32512,32513,32514,32515,32516,32642,32643,32644,32645,32646,32648,32649,32650,32651,32671,32672};
  // The pointer stays while the mouse moved this recently (e.g. NOVA's stick-driven pointer in films).
  public const long MouseGraceMs=1500;
  public static bool Enabled;
  public static bool Hidden{get{return hidden;}}
  // Replaceable for tests.
  public static Func<Point> Position=NativePosition;
  public static Func<uint> LastInput=NativeLastInput;
  public static Action HideCursors=NativeHide,ShowCursors=NativeShow;
  static bool hidden,seeded;
  static int lastX,lastY;
  static uint lastInput;
  static long lastMouse=-MouseGraceMs,lastPad=-1;
  static Point NativePosition(){Point point;GetCursorPos(out point);return point;}
  static uint NativeLastInput(){LastInputInfo info=new LastInputInfo();info.Size=(uint)Marshal.SizeOf(typeof(LastInputInfo));GetLastInputInfo(ref info);return info.Time;}
  static void NativeHide(){
   byte[] andPlane=new byte[128],xorPlane=new byte[128];
   for(int i=0;i<andPlane.Length;i++)andPlane[i]=0xFF;
   // SetSystemCursor takes ownership of each cursor, so every slot gets its own copy.
   foreach(uint id in Cursors){IntPtr blank=CreateCursor(IntPtr.Zero,0,0,32,32,andPlane,xorPlane);if(blank!=IntPtr.Zero)SetSystemCursor(blank,id);}
  }
  static void NativeShow(){SystemParametersInfo(0x57,0,IntPtr.Zero,0);}
  public static void Hide(){if(hidden)return;try{HideCursors();}catch{}hidden=true;}
  public static void Show(){try{ShowCursors();}catch{}hidden=false;}
  // Called about every 20–50 ms. padActivity: when the controller was last used beyond its dead zone.
  public static void Update(long now,long padActivity){
   if(!Enabled){if(hidden)Show();lastPad=padActivity;return;}
   Point point;uint input;
   try{point=Position();input=LastInput();}catch{return;}
   // The first look only takes a baseline.
   if(!seeded){lastX=point.X;lastY=point.Y;lastInput=input;seeded=true;lastPad=padActivity;return;}
   // A moved pointer counts as mouse use only together with new input: games that
   // re-centre the pointer themselves (SetCursorPos) do not bring it back.
   bool moved=(point.X!=lastX||point.Y!=lastY)&&input!=lastInput;
   lastX=point.X;lastY=point.Y;lastInput=input;
   if(moved){lastMouse=now;if(hidden)Show();lastPad=padActivity;return;}
   if(!hidden&&padActivity>lastPad&&now-lastMouse>=MouseGraceMs)Hide();
   lastPad=padActivity;
  }
 }
}
