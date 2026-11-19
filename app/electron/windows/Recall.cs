// C# 5 / .NET Framework 4.8. Runs only while NOVA is closed (Jarvis / Windows mode).
// Reads the controllers and nothing else: View + Menu held for 3 s starts NOVA's mode picker.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
namespace Nova {
 public static class Recall {
  [StructLayout(LayoutKind.Sequential)] struct Pad {public ushort Buttons;public byte LT,RT;public short LX,LY,RX,RY;}
  [StructLayout(LayoutKind.Sequential)] struct PadState {public uint Packet;public Pad Pad;}
  [DllImport("xinput1_4.dll",EntryPoint="XInputGetState")]static extern uint XInput(uint index,out PadState state);
  static bool NovaRunning(string exe){
   bool found=false;
   foreach(Process process in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(exe))){
    try{if(String.Equals(process.MainModule.FileName,exe,StringComparison.OrdinalIgnoreCase))found=true;}catch{}
    finally{process.Dispose();}
   }
   return found;
  }
  public static void Run(string exe,int novaPid){
   if(!File.Exists(exe))return;
   bool created;
   using(Mutex single=new Mutex(true,"Local\\NovaModeRecall",out created)){
    if(!created)return;
    // Let the NOVA that started this watcher finish quitting first.
    try{using(Process nova=Process.GetProcessById(novaPid))nova.WaitForExit(30000);}catch{}
    Thread.Sleep(3000);
    Stopwatch clock=Stopwatch.StartNew();long since=0,lastCheck=0;long[] retry=new long[4];
    while(true){
     long now=clock.ElapsedMilliseconds;
     // NOVA started some other way: it takes over the controller again.
     if(now-lastCheck>=2000){lastCheck=now;if(NovaRunning(exe))return;}
     bool held=false;
     for(uint index=0;index<4;index++){
      if(now<retry[index])continue;
      PadState state;
      // Polling an empty slot is slow; check it again only every few seconds.
      if(XInput(index,out state)!=0){retry[index]=now+3000;continue;}
      if((state.Pad.Buttons&0x30)==0x30)held=true;
     }
     if(!held)since=0;
     else{
      if(since==0)since=now;
      if(now-since>=3000){
       ProcessStartInfo start=new ProcessStartInfo(exe,"--mode-picker");
       start.UseShellExecute=false;start.WorkingDirectory=Path.GetDirectoryName(exe);
       Process.Start(start).Dispose();
       return;
      }
     }
     Thread.Sleep(50);
    }
   }
  }
 }
}
