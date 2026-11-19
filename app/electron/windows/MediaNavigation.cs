// Pure input policy, shared by the Windows helper and executable regression tests.
namespace Nova {
 public sealed class MediaNavigation {
  public string Mode = "pointer";
  public string Speed = "normal";
  string lastDirection = "";
  long nextDirection;
  public bool SetMode(string mode) {
   if(mode!="pointer"&&mode!="links"&&mode!="arrows")return false;
   Mode=mode;Reset();return true;
  }
  public bool SetSpeed(string speed) {
   if(speed!="slow"&&speed!="normal"&&speed!="fast")return false;
   Speed=speed;return true;
  }
  public double SpeedFactor { get { return Speed=="slow"?.4:Speed=="fast"?1.7:1; } }
  public void Cycle(){SetMode(Mode=="pointer"?"links":Mode=="links"?"arrows":"pointer");}
  public void Reset(){lastDirection="";nextDirection=0;}
  public string Step(ushort buttons,short lx,short ly,long now,int deadzone,int repeat) {
   if(Mode=="pointer"){Reset();return null;}
   int threshold=(int)(32767*deadzone/100.0);
   string direction=(buttons&1)!=0||ly>threshold?"up":(buttons&2)!=0||ly<-threshold?"down":(buttons&4)!=0||lx<-threshold?"left":(buttons&8)!=0||lx>threshold?"right":"";
   if(direction.Length==0){Reset();return null;}
   if(direction==lastDirection&&now<nextDirection)return null;
   nextDirection=now+(direction!=lastDirection?330:repeat);lastDirection=direction;
   return Mode=="links"?(direction=="up"||direction=="left"?"previous":"next"):direction;
  }
 }
}
