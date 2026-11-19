$ErrorActionPreference = 'Stop'
# Closes the leftover Jarvis app window (an Edge/Chrome --app window titled "Jarvis")
# after Jarvis has stopped. Only visible top-level browser windows with exactly this title.
try {
    Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
namespace Nova {
 public static class JarvisWindows {
  delegate bool EnumProc(IntPtr hwnd,IntPtr param);
  [DllImport("user32.dll")]static extern bool EnumWindows(EnumProc callback,IntPtr param);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int count);
  [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32.dll")]static extern bool PostMessage(IntPtr hwnd,uint msg,IntPtr first,IntPtr second);
  public static int Close(){
   int count=0;
   EnumWindows(delegate(IntPtr hwnd,IntPtr param){
    if(!IsWindowVisible(hwnd))return true;
    StringBuilder text=new StringBuilder(64);GetWindowText(hwnd,text,text.Capacity);
    if(text.ToString()!="Jarvis")return true;
    uint pid;GetWindowThreadProcessId(hwnd,out pid);
    string name="";
    try{name=Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant();}catch{return true;}
    if(name!="msedge"&&name!="chrome"&&name!="brave")return true;
    if(PostMessage(hwnd,0x10,IntPtr.Zero,IntPtr.Zero))count++;
    return true;
   },IntPtr.Zero);
   return count;
  }
 }
}
'@
    [Console]::Out.Write([Nova.JarvisWindows]::Close())
} catch {
    [Console]::Out.Write('0')
}
