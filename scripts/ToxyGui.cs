using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Toxy
{
    public static class Colors
    {
        public static readonly Color BgTop    = Color.FromArgb(4, 4, 6);
        public static readonly Color BgBottom = Color.FromArgb(8, 8, 10);
        public static readonly Color Accent   = Color.FromArgb(168, 85, 247);
        public static readonly Color AccentHi = Color.FromArgb(216, 180, 254);
        public static readonly Color Green    = Color.FromArgb(52, 211, 153);
        public static readonly Color GreenDeep= Color.FromArgb(16, 185, 129);
        public static readonly Color Red      = Color.FromArgb(252, 93, 93);
        public static readonly Color Dim      = Color.FromArgb(173, 157, 200);
        public static readonly Color Text     = Color.FromArgb(244, 240, 252);
        public static readonly Color Muted    = Color.FromArgb(150, 136, 176);
        public static readonly Color Panel    = Color.FromArgb(6, 6, 8);
        public static readonly Color Line     = Color.FromArgb(70, 60, 60, 70);
    }

    public static class Logo
    {
        public const string PngB64 = "__LOGO_PNG_B64__";
        public static Image Load()
        {
            if (string.IsNullOrEmpty(PngB64) || PngB64.StartsWith("__LOGO")) return null;
            try { using (var ms = new MemoryStream(Convert.FromBase64String(PngB64))) return Image.FromStream(ms); }
            catch { return null; }
        }
    }

    public static class Helpers
    {
        public static GraphicsPath RoundedRect(Rectangle r, int rad)
        {
            int d = rad * 2;
            GraphicsPath p = new GraphicsPath();
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }
        public static Color Blend(Color a, Color b, float t)
        {
            t = Math.Max(0, Math.Min(1, t));
            return Color.FromArgb(
                (int)(a.R + (b.R - a.R) * t),
                (int)(a.G + (b.G - a.G) * t),
                (int)(a.B + (b.B - a.B) * t));
        }
    }

    public class GlowButton : Control, IButtonControl
    {
        private float hover = 0f;
        private bool pressed = false;
        private DialogResult dialogResult = DialogResult.None;
        private bool isDefault = false;
        public Color BaseColor { get; set; }
        public Color HoverColor { get; set; }

        public DialogResult DialogResult { get { return dialogResult; } set { dialogResult = value; } }
        public void NotifyDefault(bool value) { isDefault = value; Invalidate(); }
        public void PerformClick() { OnClick(EventArgs.Empty); }

        public GlowButton()
        {
            DoubleBuffered = true;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
            Cursor = Cursors.Hand;
            Font = new Font("Segoe UI Semibold", 11f, FontStyle.Regular);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
            Rectangle rc = ClientRectangle; rc.Inflate(-3, -3);
            Color fill = pressed ? Helpers.Blend(BaseColor, Color.Black, 0.25f)
                         : Helpers.Blend(BaseColor, Helpers.Blend(HoverColor, Color.White, 0.06f), hover);
            using (var path = Helpers.RoundedRect(rc, 24))
            {
                using (var b = new LinearGradientBrush(rc, fill, Helpers.Blend(fill, Color.Black, 0.32f), 90f))
                    g.FillPath(b, path);
                using (var pen = new Pen(Color.FromArgb((int)(120 + 130 * hover), 255, 255, 255), 1.2f))
                    g.DrawPath(pen, path);
                var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
                using (var sb = new SolidBrush(Color.White)) g.DrawString(Text, Font, sb, rc, sf);
            }
        }
        protected override void OnMouseEnter(EventArgs e) { base.OnMouseEnter(e); hover = 1f; Invalidate(); }
        protected override void OnMouseLeave(EventArgs e) { base.OnMouseLeave(e); hover = 0f; Invalidate(); }
        protected override void OnMouseDown(MouseEventArgs e) { base.OnMouseDown(e); pressed = true; Invalidate(); }
        protected override void OnMouseUp(MouseEventArgs e) { base.OnMouseUp(e); pressed = false; Invalidate(); }
    }

    public class Radar : Control
    {
        private Timer timer;
        private float angle = 0f;
        private readonly Random rnd = new Random();
        private List<Blip> blips = new List<Blip>();
        private class Blip { public float X, Y; public int Age; }

        public Radar()
        {
            DoubleBuffered = true;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
            timer = new Timer();
            timer.Interval = 30;
            timer.Tick += (s, e) =>
            {
                angle = (angle + 2.2f) % 360f;
                for (int i = blips.Count - 1; i >= 0; i--) { blips[i].Age++; if (blips[i].Age > 60) blips.RemoveAt(i); }
                if (rnd.Next(6) == 0)
                {
                    float a = (float)(rnd.NextDouble() * Math.PI * 2);
                    float r = (float)(rnd.NextDouble() * 0.8) * Math.Min(Width, Height) / 2f;
                    blips.Add(new Blip { X = (float)Math.Cos(a) * r, Y = (float)Math.Sin(a) * r, Age = 0 });
                }
                Invalidate();
            };
            timer.Start();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            int cx = Width / 2, cy = Height / 2;
            int maxR = Math.Min(Width, Height) / 2 - 6;
            Color ac = Helpers.Blend(Colors.Accent, Color.White, 0.15f);

            using (var bg = new SolidBrush(Color.FromArgb(20, Colors.Panel))) g.FillEllipse(bg, cx - maxR, cy - maxR, maxR * 2, maxR * 2);
            using (var pen = new Pen(Color.FromArgb(200, ac), maxR / 20f)) g.DrawEllipse(pen, cx - maxR, cy - maxR, maxR * 2, maxR * 2);

            for (int i = 1; i <= 3; i++)
            {
                int r = maxR * i / 3;
                using (var pen = new Pen(Color.FromArgb(34, Colors.AccentHi), 1f)) g.DrawEllipse(pen, cx - r, cy - r, r * 2, r * 2);
            }
            using (var pen = new Pen(Color.FromArgb(30, ac), 1f))
            {
                g.DrawLine(pen, cx - maxR, cy, cx + maxR, cy);
                g.DrawLine(pen, cx, cy - maxR, cx, cy + maxR);
            }

            float rad = angle * (float)Math.PI / 180f;
            using (var path = new GraphicsPath())
            {
                path.AddPie(cx - maxR, cy - maxR, maxR * 2, maxR * 2, angle - 32f, 32f);
                using (var sw = new PathGradientBrush(path))
                {
                    sw.CenterColor = Color.FromArgb(120, ac);
                    sw.SurroundColors = new Color[] { Color.FromArgb(0, ac) };
                    g.FillPath(sw, path);
                }
            }
            float tx = cx + (float)Math.Cos(rad) * maxR;
            float ty = cy + (float)Math.Sin(rad) * maxR;
            using (var pen = new Pen(Color.FromArgb(230, ac), 2.2f)) g.DrawLine(pen, cx, cy, tx, ty);

            foreach (var b in blips)
            {
                int alpha = b.Age < 18 ? 255 : Math.Max(0, 255 - (b.Age - 18) * 6);
                using (var bs = new SolidBrush(Color.FromArgb(alpha, Colors.Green))) g.FillEllipse(bs, cx + b.X - 3, cy + b.Y - 3, 6, 6);
            }
            using (var bs = new SolidBrush(ac)) g.FillEllipse(bs, cx - 5, cy - 5, 10, 10);
        }
    }

    public class Sparkles : Control
    {
        private class PArticle { public float X, Y, VX, VY, S, Ph; }
        private readonly System.Collections.Generic.List<PArticle> parts = new System.Collections.Generic.List<PArticle>();
        private readonly Random rnd = new Random();
        private Timer timer;
        public Sparkles()
        {
            DoubleBuffered = true;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
            timer = new Timer { Interval = 33 };
            timer.Tick += (s, e) => { Step(); Invalidate(); };
            timer.Start();
            this.Resize += (s, e) => { if (parts.Count == 0) Seed(); };
            Seed();
        }
        private void Seed()
        {
            parts.Clear();
            int n = Math.Max(24, Math.Min(110, (this.Width * this.Height) / 144));
            for (int i = 0; i < n; i++) parts.Add(NewPart());
        }
        private PArticle NewPart()
        {
            var p = new PArticle();
            p.X = (float)(rnd.NextDouble() * Math.Max(1, Width));
            p.Y = (float)(rnd.NextDouble() * Math.Max(1, Height));
            p.VX = (float)(rnd.NextDouble() * 0.7 - 0.35);
            p.VY = (float)(rnd.NextDouble() * 0.5 + 0.08);
            p.S  = 1.4f + (float)rnd.NextDouble() * 2.4f;
            p.Ph = (float)(rnd.NextDouble() * Math.PI * 2.0);
            return p;
        }
        private void Step()
        {
            foreach (var p in parts)
            {
                p.X += p.VX; if (p.X < -8) p.X = Width + 8; else if (p.X > Width + 8) p.X = -8;
                p.Y += p.VY; if (p.Y > Height + 8) p.Y = -8;
                p.Ph += 0.07f;
            }
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            foreach (var p in parts)
            {
                float v = (float)Math.Sin(p.Ph);
                float a = 0.30f + 0.65f * Math.Abs(v);
                int al = (int)(255.0 * a);
                int s = (int)p.S;
                var pts = new PointF[] { new PointF(p.X, p.Y - s), new PointF(p.X + s, p.Y), new PointF(p.X, p.Y + s), new PointF(p.X - s, p.Y) };
                using (var b = new SolidBrush(Color.FromArgb(al, Colors.AccentHi))) g.FillPolygon(b, pts);
                int r = Math.Max(3, (int)(p.S * 3.4f));
                int gal = (int)(al * 0.25);
                if (gal > 0) using (var gl = new SolidBrush(Color.FromArgb(gal, Colors.AccentHi))) g.FillEllipse(gl, p.X - r, p.Y - r, r + r, r + r);
            }
        }
    }
    public class ShineBar : Control
    {
        private Timer timer;
        private float offset = 0f;
        private double _value = 0.0;
        public double Value { get { return _value; } set { _value = value; Invalidate(); } }
        public void Pulse(long ms) { offset = (float)((ms / 8.0) % 100.0); Invalidate(); }
        public ShineBar()
        {
            DoubleBuffered = true;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
            timer = new Timer { Interval = 30 };
            timer.Tick += (s, e) => { offset = (offset + 3f) % 100f; Animate(); Invalidate(); };
            timer.Start();
        }

        private double _shown = 0.0f;
        private void Animate()
        {
            // Ease the visible fill toward the target so it never jumps, and run 0 -> 100.
            _shown += (Value - _shown) * 0.08;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle rc = ClientRectangle; rc.Inflate(-2, -2);
            using (var path = Helpers.RoundedRect(rc, 12))
            {
                using (var bg = new SolidBrush(Color.FromArgb(100, Color.Black))) g.FillPath(bg, path);
                Rectangle fill = rc; fill.Inflate(2, 2);
                g.SetClip(path);
                double shownPct = Math.Max(0.02, Math.Min(1, _shown));
                float track = (float)shownPct * rc.Width;
                using (var fb = new LinearGradientBrush(new RectangleF(rc.X, rc.Y, track, rc.Height), Color.FromArgb(210, Colors.Accent), Colors.AccentHi, 0f))
                    g.FillRectangle(fb, new RectangleF(rc.X, rc.Y, track, rc.Height));
                float start = rc.X + rc.Width * offset / 100f - rc.Width;
                var sweep = new RectangleF(start, rc.Y, rc.Width, rc.Height);
                using (var lg = new LinearGradientBrush(sweep, Color.Transparent, Color.FromArgb(120, Color.White), LinearGradientMode.Horizontal))
                {
                    lg.SetBlendTriangularShape(0.5f, 1f);
                    g.FillRectangle(lg, sweep.X, rc.Y, rc.Width * 1.5f, rc.Height);
                }
                g.ResetClip();
                using (var pen = new Pen(Color.FromArgb(150, Colors.AccentHi), 1.2f)) g.DrawPath(pen, path);
            }
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
            int pct = (int)Math.Round(Math.Max(0, Math.Min(1, _shown)) * 100.0);
            using (var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
            using (var sb = new SolidBrush(Colors.Text))
            using (var f = new Font("Segoe UI Semibold", 9f, FontStyle.Bold))
                g.DrawString(pct + "%", f, sb, rc, sf);
        }
    }

    public class ToxyForm : Form
    {
        public string Result = "NO";
        public Image LogoImage { get; set; }
        public bool LogoBottomLeft { get; set; }
        public bool LogoCenterTop { get; set; }


        [DllImport("user32.dll")] private static extern bool ReleaseCapture();
        [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
        private const int WS_EX_COMPOSITED = 0x02000000;

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= WS_EX_COMPOSITED;
                return cp;
            }
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == 0x0014) return; // WM_ERASEBKGND: skip erasing, we repaint fully every frame
            base.WndProc(ref m);
        }

        public ToxyForm(int w, int h)
        {
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(w, h);
            BackColor = Colors.Panel;
            DoubleBuffered = true;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);
            using (var p = Helpers.RoundedRect(new Rectangle(0, 0, w, h), 20)) Region = new Region(p);
            SeedSparkles();
            sparkTimer = new Timer { Interval = 40 };
            sparkTimer.Tick += (a, m2) => { UpdateSparkles(); Invalidate(); };
            sparkTimer.Start();
            Font = new Font("Segoe UI", 10f, FontStyle.Regular);
        }

        private System.Collections.Generic.List<Sparkle> sparkles = new System.Collections.Generic.List<Sparkle>();
        private readonly Random sprng = new Random();
        private Timer sparkTimer;
        private class Sparkle { public float X, Y, VX, VY, S, Ph; }

        private void SeedSparkles()
        {
            sparkles.Clear();
            int n = Math.Max(30, Math.Min(120, (ClientSize.Width * ClientSize.Height) / 200));
            for (int i = 0; i < n; i++) sparkles.Add(NewSparkle());
        }
        private Sparkle NewSparkle()
        {
            Sparkle s2 = new Sparkle();
            s2.X = (float)(sprng.NextDouble() * Math.Max(1, ClientSize.Width));
            s2.Y = (float)(sprng.NextDouble() * Math.Max(1, ClientSize.Height));
            s2.VX = (float)(sprng.NextDouble() * 0.7 - 0.35);
            s2.VY = (float)(sprng.NextDouble() * 0.5 + 0.08);
            s2.S  = 1.4f + (float)sprng.NextDouble() * 2.4f;
            s2.Ph = (float)(sprng.NextDouble() * Math.PI * 2.0);
            return s2;
        }
        private void UpdateSparkles()
        {
            foreach (Sparkle s2 in sparkles)
            {
                s2.X += s2.VX; if (s2.X < -8) s2.X = ClientSize.Width + 8; else if (s2.X > ClientSize.Width + 8) s2.X = -8;
                s2.Y += s2.VY; if (s2.Y > ClientSize.Height + 8) s2.Y = -8;
                s2.Ph += 0.07f;
            }
        }
        private void DrawSparkles(Graphics g)
        {
            foreach (Sparkle s2 in sparkles)
            {
                float a = 0.30f + 0.65f * Math.Abs((float)Math.Sin(s2.Ph));
                int al = (int)(255.0 * a);
                int s = (int)s2.S;
                PointF[] pts = new PointF[] { new PointF(s2.X, s2.Y - s), new PointF(s2.X + s, s2.Y), new PointF(s2.X, s2.Y + s), new PointF(s2.X - s, s2.Y) };
                using (SolidBrush br = new SolidBrush(Color.FromArgb(al, Colors.AccentHi))) g.FillPolygon(br, pts);
                int r = Math.Max(3, (int)(s2.S * 3.4f));
                int gal = (int)(al * 0.25);
                if (gal > 0) using (SolidBrush gl = new SolidBrush(Color.FromArgb(gal, Colors.AccentHi))) g.FillEllipse(gl, s2.X - r, s2.Y - r, r + r, r + r);
            }
        }
        protected override void Dispose(bool disposing)
        {
            if (disposing && sparkTimer != null) { sparkTimer.Stop(); sparkTimer.Dispose(); }
            base.Dispose(disposing);
        }
        protected override void OnPaintBackground(PaintEventArgs e)
        {
            var g = e.Graphics;
            using (var b = new LinearGradientBrush(ClientRectangle, Colors.BgTop, Colors.BgBottom, 90f))
                g.FillRectangle(b, ClientRectangle);
            using (var fill = new SolidBrush(Colors.BgTop))
                g.FillRectangle(fill, ClientRectangle);
if (LogoImage != null)
            {
                int size = Math.Min((int)(ClientSize.Width * 0.34), ClientSize.Height / 3);
                int capW = ClientSize.Width - 80;
                if (size > capW) size = capW;
                Rectangle rect = LogoCenterTop
                    ? new Rectangle(ClientSize.Width / 2 - size / 2, 26, size, size)
                    : LogoBottomLeft
                        ? new Rectangle(ClientSize.Width - size - 30, ClientSize.Height - size - 30, size, size)
                        : new Rectangle(ClientSize.Width - size - 30, 24, size, size);
                g.DrawImage(LogoImage, rect);
            }
            DrawSparkles(g);
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button == MouseButtons.Left) { ReleaseCapture(); SendMessage(this.Handle, 0x00A1, new IntPtr(2), IntPtr.Zero); }
        }
        protected override void OnKeyDown(KeyEventArgs e)
        {
            base.OnKeyDown(e);
            if (e.KeyCode == Keys.Escape) { Result = "NO"; Close(); }
        }
        protected void MakeDraggable(Control c)
        {
            c.MouseDown += (s, e) =>
            {
                if (e.Button == MouseButtons.Left) { ReleaseCapture(); SendMessage(this.Handle, 0x00A1, new IntPtr(2), IntPtr.Zero); }
            };
        }
    }

    public class StatusPill : Control
    {
        private Timer t;
        private float a = 1f; private bool up = false;
        public StatusPill()
        {
            DoubleBuffered = true;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
            t = new Timer { Interval = 40 };
            t.Tick += (s, e) => { a += up ? -0.06f : 0.06f; if (a <= 0.35f) up = false; if (a >= 1f) up = true; Invalidate(); };
            t.Start();
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle rc = ClientRectangle;
            using (var path = Helpers.RoundedRect(rc, rc.Height / 2))
            {
                using (var b = new SolidBrush(Color.FromArgb(60, Colors.Green))) g.FillPath(b, path);
                using (var pen = new Pen(Color.FromArgb(120, Colors.Green), 1.2f)) g.DrawPath(pen, path);
            }
            int d = (int)(rc.Height * (0.28f + 0.14f * a)) + 2;
            using (var dot = new SolidBrush(Colors.Green)) g.FillEllipse(dot, rc.X + 8, rc.Y + rc.Height / 2 - d / 2, d, d);
            using (var sb = new SolidBrush(Colors.Text))
            using (var f = new Font("Segoe UI Semibold", 8.5f))
            {
                var m = g.MeasureString(Text, f);
                g.DrawString(Text, f, sb, rc.X + d + 18, rc.Y + rc.Height / 2 - m.Height / 2 + 1);
            }
        }
    }

    public class ResultCircle : Control
    {
        private Timer timer;
        private float spin = 0f;
        private float scale = 0.15f;
        private bool _success = true;
        public bool Success { get { return _success; } set { _success = value; } }
        public ResultCircle()
        {
            DoubleBuffered = true;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
            Size = new Size(150, 150);
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);
            timer = new Timer { Interval = 25 };
            timer.Tick += (s, e) => { spin = (spin + 9f) % 360f; scale += (1f - scale) * 0.12f; Invalidate(); };
            timer.Start();
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            int cx = Width / 2, cy = Height / 2;
            Color c = Success ? Colors.Green : Colors.Red;
            int maxR = Math.Min(Width, Height) / 2 - 8;
            using (var pen = new Pen(Color.FromArgb(120, c), 3f))
                g.DrawArc(pen, new Rectangle(cx - maxR, cy - maxR, maxR * 2, maxR * 2), spin, 110f);
            int d = (int)(maxR * 0.82 * Math.Max(0.6, scale));
            var r = new Rectangle(cx - d, cy - d, d * 2, d * 2);
            using (var b = new LinearGradientBrush(r, Color.FromArgb(255, c), Color.FromArgb(255, Helpers.Blend(c, Color.White, 0.4f)), 45f))
            using (var path = Helpers.RoundedRect(r, d))
                g.FillPath(b, path);
            using (var pen = new Pen(Color.White, d / 4.6f))
            {
                pen.StartCap = LineCap.Round; pen.EndCap = LineCap.Round;
                if (Success)
                {
                    int o = d / 4;
                    g.DrawLine(pen, cx - o, cy, cx - d / 5, cy + o);
                    g.DrawLine(pen, cx - d / 5, cy + o, cx + d / 2, cy - o);
                }
                else
                {
                    int a = d / 2;
                    g.DrawLine(pen, cx - a, cy - a, cx + a, cy + a);
                    g.DrawLine(pen, cx + a, cy - a, cx - a, cy + a);
                }
            }
        }
    }

    public class AnimatedStatus : Control
    {
        private int idx = 0;
        private Timer t;
        private static readonly string[] Steps = {
            "Reading system information...",
            "Scanning installed programs...",
            "Checking running processes...",
            "Inspecting files and folders...",
            "Analyzing Windows forensics...",
            "Encrypting and sending results..."
        };
        public AnimatedStatus()
        {
            DoubleBuffered = true;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
            Font = new Font("Segoe UI", 12f, FontStyle.Regular);
            t = new Timer { Interval = 550 };
            t.Tick += (s, e) => { idx = (idx + 1) % Steps.Length; Invalidate(); };
            t.Start();
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            var g = e.Graphics;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
            using (var sb = new SolidBrush(ForeColor))
                g.DrawString(Steps[idx], Font, sb, 2, 4);
        }
    }

    public class ConsentForm : ToxyForm
    {
        public ConsentForm() : base(720, 520)
        {
            LogoImage = Logo.Load();
            LogoCenterTop = true;

            var pill = new StatusPill { Text = "working", Size = new Size(104, 28), Location = new Point(308, 140), ForeColor = Colors.Text };
            Controls.Add(pill); MakeDraggable(pill);

            var subtitle = new Label { Text = "Consent-based PC Integrity Checker", Font = new Font("Segoe UI", 11f), ForeColor = Colors.Muted, Location = new Point(220, 182), BackColor = Color.Transparent, AutoSize = true };
            Controls.Add(subtitle); MakeDraggable(subtitle);

            var panel = new Panel { Location = new Point(40, 240), Size = new Size(644, 176), BackColor = Color.Transparent };
            using (var p = Helpers.RoundedRect(new Rectangle(0, 0, 644, 176), 16)) panel.Region = new Region(p);
            panel.Paint += (s, e) =>
            {
                var g = e.Graphics;
                g.SmoothingMode = SmoothingMode.AntiAlias;
                using (var sp = Helpers.RoundedRect(new Rectangle(0, 0, 643, 175), 16))
                {
                    using (var fill = new SolidBrush(Color.FromArgb(150, 5, 5, 7))) g.FillPath(fill, sp);
                    using (var pen = new Pen(Colors.Line, 1f)) g.DrawPath(pen, sp);
                }
                var items = new[] {
                    "Detects cheat software, injectors and memory tools",
                    "Checks processes, installs, files and Windows forensics",
                    "Results go to the person who sent you this tool",
                    "No personal files are read or uploaded"
                };
                int y = 22;
                using (var chkFont = new Font("Segoe UI Symbol", 13f, FontStyle.Regular))
                using (var txtFont = new Font("Segoe UI", 10.5f))
                using (var chkB = new SolidBrush(Colors.Green))
                using (var txtB = new SolidBrush(Colors.Text))
                {
                    foreach (var item in items)
                    {
                        g.FillEllipse(chkB, 40, y + 6, 8, 8);
                        g.DrawString(item, txtFont, txtB, 62, y);
                        y += 38;
                    }
                }
            };
            Controls.Add(panel);

            var footer = new Label { Text = "This scan is consensual and reversible  -  approve to continue.", ForeColor = Colors.Muted, Font = new Font("Segoe UI", 9f), Location = new Point(42, 428), BackColor = Color.Transparent, AutoSize = true };
            Controls.Add(footer);

            var check = new GlowButton { Text = "CHECK PC", BaseColor = Colors.Accent, HoverColor = Colors.AccentHi, Size = new Size(300, 58), Location = new Point(40, 448) };
            check.Click += (s, e) => { Result = "YES"; Close(); };
            Controls.Add(check);

            var decl = new GlowButton { Text = "DECLINE", BaseColor = Color.FromArgb(64, 58, 84), HoverColor = Colors.Red, Size = new Size(320, 58), Location = new Point(368, 448) };
            decl.Click += (s, e) => { Result = "NO"; Close(); };
            Controls.Add(decl);

            AcceptButton = check; CancelButton = decl;
        }
    }

    public class WaitScreen : ToxyForm
    {
        private readonly Timer poll;
        public WaitScreen(string progressFile) : base(760, 300)
        {
            LogoImage = Logo.Load();
            var radar = new Radar { Size = new Size(170, 170), Location = new Point(30, 60) };
            Controls.Add(radar); MakeDraggable(radar);

            var title = new Label { Text = "SCANNING", Font = new Font("Segoe UI", 26f, FontStyle.Bold), ForeColor = Colors.Text, Location = new Point(230, 44), BackColor = Color.Transparent, AutoSize = true };
            Controls.Add(title); MakeDraggable(title);

            var sub = new AnimatedStatus { Location = new Point(232, 96), Size = new Size(470, 30), ForeColor = Colors.Dim };
            Controls.Add(sub); MakeDraggable(sub);

            var bar = new ShineBar { Location = new Point(232, 150), Size = new Size(470, 26) };
            Controls.Add(bar);

            var stat = new Label { Text = "Inspecting processes, files and system artifacts...", Font = new Font("Segoe UI", 9.5f), ForeColor = Colors.Muted, Location = new Point(232, 194), BackColor = Color.Transparent, AutoSize = true };
            Controls.Add(stat);
            var note = new Label { Text = "Do not close this window while the scan is running.", ForeColor = Colors.Muted, Font = new Font("Segoe UI", 9f), Location = new Point(232, 220), BackColor = Color.Transparent, AutoSize = true };
            Controls.Add(note);

            // Poll the progress file written by scan-client and drive the bar to 100%.
            if (!string.IsNullOrEmpty(progressFile))
            {
                string file = progressFile;
                Action readProgress = () =>
                {
                    try
                    {
                        string raw = File.ReadAllText(file);
                        var m = System.Text.RegularExpressions.Regex.Match(raw, "pct\"\\s*:\\s*([0-9.]+)");
                        if (m.Success)
                        {
                            double pct = double.Parse(m.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture);
                            bar.Value = Math.Max(0, Math.Min(100, pct)) / 100.0;
                        }
                    }
                    catch { }
                };
                readProgress();
                poll = new Timer { Interval = 150 };
                poll.Tick += (s, e) => readProgress();
                poll.Start();
            }
        }
    }

    public class DoneScreen : ToxyForm
    {
        public DoneScreen(string jsonPath) : base(720, 380)
        {
            LogoImage = Logo.Load();
            LogoBottomLeft = true;

            string title = "SCAN COMPLETE";
            string message = "Your results were sent successfully.";
            bool ok = true;
            try
            {
                var parts = ParseJson(jsonPath);
                title = (string)(parts[0] ?? title);
                message = (string)(parts[1] ?? message);
                ok = title.IndexOf("failed", StringComparison.OrdinalIgnoreCase) < 0;
            }
            catch { }

            var circle = new ResultCircle { Location = new Point(44, 104), Success = ok };
            Controls.Add(circle);

            var titleLabel = new Label { Text = title, Font = new Font("Segoe UI", 24f, FontStyle.Bold), ForeColor = ok ? Colors.Green : Colors.Red, Location = new Point(230, 58), BackColor = Color.Transparent, AutoSize = true };
            Controls.Add(titleLabel); MakeDraggable(titleLabel);

            var msg = new Label { Text = message, Font = new Font("Segoe UI", 11.5f), ForeColor = Colors.Text, Location = new Point(230, 116), MaximumSize = new Size(430, 120), BackColor = Color.Transparent, AutoSize = true };
            Controls.Add(msg); MakeDraggable(msg);

            var sub = new Label { Text = ok ? "Thank you for running Tester Anti-Cheat." : "Please send the report to the person who gave you this tool.", ForeColor = Colors.Muted, Font = new Font("Segoe UI", 10f), Location = new Point(230, 240), BackColor = Color.Transparent, AutoSize = true };
            Controls.Add(sub);

            var okBtn = new GlowButton { Text = ok ? "FINISH" : "CLOSE", BaseColor = Colors.GreenDeep, HoverColor = Colors.Green, Size = new Size(190, 54), Location = new Point(230, 288) };
            okBtn.Click += (s, e) => { Result = "OK"; Close(); };
            Controls.Add(okBtn);
        }

        private static object[] ParseJson(string path)
        {
            if (string.IsNullOrEmpty(path) || !File.Exists(path)) throw new Exception("no json");
            string raw = File.ReadAllText(path);
            return new object[] { Extract(raw, "title"), Extract(raw, "message") };
        }
        private static string Extract(string raw, string key)
        {
            var m = System.Text.RegularExpressions.Regex.Match(raw, "\"" + key + "\"\\s*:\\s*\"((?:\\\\.|[^\"])*)\"");
            if (!m.Success) return null;
            return m.Groups[1].Value.Replace("\\n", "\n").Replace("\\\"", "\"");
        }
    }

    public static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            AppDomain.CurrentDomain.UnhandledException += (s, e) =>
            {
                try { File.WriteAllText(Path.Combine(Path.GetTempPath(), "toxy-gui-crash.txt"), e.ExceptionObject.ToString()); } catch { }
                Environment.Exit(1);
            };
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.ThreadException += (s, e) =>
            {
                try { File.WriteAllText(Path.Combine(Path.GetTempPath(), "toxy-gui-thread.txt"), e.Exception.ToString()); } catch { }
            };
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            string mode = args.Length > 0 ? args[0].ToLowerInvariant() : "consent";
            string aux = args.Length > 1 ? args[1] : null;
            if (mode == "wait") Application.Run(new WaitScreen(aux));
            else if (mode == "done") Application.Run(new DoneScreen(aux));
            else
            {
                var f = new ConsentForm();
                Application.Run(f);
                if (!string.IsNullOrEmpty(aux)) { try { File.WriteAllText(aux, f.Result); } catch { } }
            }
        }
    }
}