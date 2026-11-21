// C# 5 / .NET Framework 4.8. Runs only while NOVA is closed (Jarvis / Windows mode).
// Reads the controllers and Parsec's host log, nothing else. View + Menu held for
// 3 s, or a new Parsec connection, starts NOVA's mode picker. While a controller
// is in use the mouse pointer is hidden (CursorHide.cs), as in NOVA.
// NOVA compiles this file into a small windowless program (nova-figyelo-*.exe);
// recall.ps1 is the fallback. What it does goes into NOVA's mode picker log.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
namespace Nova {
 public static class Recall {
  [StructLayout(LayoutKind.Sequential)] struct Pad {public ushort Buttons;public byte LT,RT;public short LX,LY,RX,RY;}
  [StructLayout(LayoutKind.Sequential)] struct PadState {public uint Packet;public Pad Pad;}
  [DllImport("xinput1_4.dll",EntryPoint="XInputGetState")]static extern uint XInput(uint index,out PadState state);
  // Same rules as parsec-watch.cjs: "[I date] Name#123 connected." counts, a reconnect within 2 minutes does not.
  static readonly Regex Connected=new Regex(@"\]\s*(\S.*?#\d+)\s+connected\.?\s*$",RegexOptions.IgnoreCase);
  static readonly Regex Disconnected=new Regex(@"\]\s*(\S.*?#\d+)\s+disconnected\.?\s*$",RegexOptions.IgnoreCase);
  sealed class LogFile {public string Path;public long Offset;public string Rest="";public string Status="";}
  static string LogPath="";
  static int Samples;
  static void Log(string text){
   if(LogPath.Length==0)return;
   try{File.AppendAllText(LogPath,DateTime.Now.ToString("yyyy. MM. dd. H:mm:ss")+"  figyelő  "+text+"\r\n",new UTF8Encoding(false));}catch{}
  }
  static void Status(LogFile log,string status){if(log.Status==status)return;log.Status=status;Log("Parsec-napló ("+log.Path+"): "+status);}
  static readonly Dictionary<string,long> Dropped=new Dictionary<string,long>();
  static long Length(string path){try{FileInfo info=new FileInfo(path);return info.Exists?info.Length:-1;}catch{return -1;}}
  static List<LogFile> ParsecLogs(){
   List<LogFile> logs=new List<LogFile>();
   foreach(Environment.SpecialFolder folder in new Environment.SpecialFolder[]{Environment.SpecialFolder.CommonApplicationData,Environment.SpecialFolder.ApplicationData}){
    LogFile log=new LogFile();log.Path=Path.Combine(Path.Combine(Environment.GetFolderPath(folder),"Parsec"),"log.txt");
    log.Offset=Math.Max(0,Length(log.Path));logs.Add(log);
   }
   return logs;
  }
  static bool ParsecConnected(List<LogFile> logs,long now){
   bool found=false;
   foreach(LogFile log in logs){
    long length=Length(log.Path);
    if(length<0){log.Offset=0;log.Rest="";Status(log,"nem található");continue;}
    if(length<log.Offset){log.Offset=0;log.Rest="";}
    if(length==log.Offset)continue;
    string text;
    try{
     using(FileStream stream=new FileStream(log.Path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete)){
      long start=Math.Max(log.Offset,length-262144);stream.Seek(start,SeekOrigin.Begin);
      byte[] buffer=new byte[length-start];int count=stream.Read(buffer,0,buffer.Length);
      text=log.Rest+Encoding.UTF8.GetString(buffer,0,count);
     }
    }catch(Exception e){Status(log,"nem olvasható: "+e.Message);continue;}
    Status(log,"olvasható");
    log.Offset=length;
    string[] lines=text.Split('\n');log.Rest=lines[lines.Length-1];
    for(int i=0;i<lines.Length-1;i++){
     string line=lines[i].TrimEnd('\r');
     Match gone=Disconnected.Match(line);
     if(gone.Success){Dropped[gone.Groups[1].Value]=now;Log("Parsec: "+gone.Groups[1].Value+" lecsatlakozott");continue;}
     Match joined=Connected.Match(line);
     if(!joined.Success){
      // Unknown wording: kept so the pattern can be adjusted to this Parsec version.
      if(Samples<20&&line.IndexOf("connect",StringComparison.OrdinalIgnoreCase)>=0){Samples++;Log("Parsec-sor: "+(line.Length>200?line.Substring(0,200):line));}
      continue;
     }
     long last;
     if(Dropped.TryGetValue(joined.Groups[1].Value,out last)&&now-last<120000){Log("Parsec: "+joined.Groups[1].Value+" újracsatlakozott, kihagyva");continue;}
     Log("Parsec: "+joined.Groups[1].Value+" csatlakozott, módválasztó");
     found=true;
    }
   }
   return found;
  }
  static bool NovaRunning(string exe){
   bool found=false;
   foreach(Process process in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(exe))){
    try{if(String.Equals(process.MainModule.FileName,exe,StringComparison.OrdinalIgnoreCase))found=true;}catch{}
    finally{process.Dispose();}
   }
   return found;
  }
  static void StartPicker(string exe){
   try{
    ProcessStartInfo start=new ProcessStartInfo(exe,"--mode-picker");
    start.UseShellExecute=false;start.WorkingDirectory=Path.GetDirectoryName(exe);
    Process.Start(start).Dispose();
   }catch(Exception e){Log("a NOVA nem indult el: "+e.Message);}
  }
  // Entry point of nova-figyelo.exe: NOVA.exe path, NOVA pid, Parsec 1/0, log file, hide pointer 1/0.
  public static void Main(string[] args){
   int pid;
   if(args.Length<3||!Int32.TryParse(args[1],out pid))return;
   try{Run(args[0],pid,args[2]=="1",args.Length>3?args[3]:"",args.Length>4&&args[4]=="1");}catch(Exception e){Log("hiba: "+e.Message);}
   finally{CursorHide.Show();}
  }
  public static void Run(string exe,int novaPid,bool parsec,string logPath,bool cursor){
   LogPath=logPath??"";
   CursorHide.Enabled=cursor;
   if(!File.Exists(exe)){Log("nem található: "+exe);return;}
   bool created;
   using(Mutex single=new Mutex(true,"Local\\NovaModeRecall",out created)){
    if(!created){Log("már fut egy figyelő");return;}
    // Let the NOVA that started this watcher finish quitting first.
    try{using(Process nova=Process.GetProcessById(novaPid))if(!nova.WaitForExit(30000))Log("a NOVA 30 mp alatt sem lépett ki");}catch{}
    Thread.Sleep(3000);
    List<LogFile> logs=parsec?ParsecLogs():new List<LogFile>();
    Log("elindult (View + Menü 3 mp"+(parsec?", Parsec-csatlakozás":"")+")");
    Stopwatch clock=Stopwatch.StartNew();long since=0,lastCheck=0,lastLog=0,padInput=-1;long[] retry=new long[4];bool pads=true;
    while(true){
     long now=clock.ElapsedMilliseconds;
     // NOVA started some other way: it takes over the controller and Parsec again.
     if(now-lastCheck>=2000){lastCheck=now;if(NovaRunning(exe)){Log("kilép: a NOVA fut");return;}}
     if(parsec&&now-lastLog>=1500){lastLog=now;if(ParsecConnected(logs,now)){StartPicker(exe);return;}}
     bool held=false;
     for(uint index=0;index<4&&pads;index++){
      if(now<retry[index])continue;
      PadState state;uint result;
      try{result=XInput(index,out state);}catch(Exception e){pads=false;Log("kontroller nem olvasható: "+e.Message);break;}
      // Polling an empty slot is slow; check it again only every few seconds.
      if(result!=0){retry[index]=now+3000;continue;}
      if((state.Pad.Buttons&0x30)==0x30)held=true;
      Pad pad=state.Pad;const int limit=11468;
      if(pad.Buttons!=0||pad.LT>30||pad.RT>30||Math.Abs((int)pad.LX)>limit||Math.Abs((int)pad.LY)>limit||Math.Abs((int)pad.RX)>limit||Math.Abs((int)pad.RY)>limit)padInput=now;
     }
     CursorHide.Update(now,padInput);
     if(!held)since=0;
     else{
      if(since==0)since=now;
      if(now-since>=3000){Log("View + Menü: módválasztó");StartPicker(exe);return;}
     }
     Thread.Sleep(50);
    }
   }
  }
 }
}
