namespace WallpaperHost;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();

        // args[0]: absolute path to the wallpaper content folder (contains index.html)
        // args[1..4]: display bounds (x, y, width, height) — required for real
        // (main.js-spawned) usage; falls back to the primary screen when
        // omitted, for quick manual testing.
        // args[5] (optional): a real image/video file path, sent through the
        // host bridge as a one-off test "set-wallpaper" message a couple
        // seconds after load — this is how part 3 was validated end-to-end.
        var contentDir = args.Length > 0
            ? args[0]
            : Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "wallpaper");

        Rectangle bounds;
        if (args.Length >= 5 &&
            int.TryParse(args[1], out var x) && int.TryParse(args[2], out var y) &&
            int.TryParse(args[3], out var w) && int.TryParse(args[4], out var h))
        {
            bounds = new Rectangle(x, y, w, h);
        }
        else
        {
            bounds = Screen.PrimaryScreen?.Bounds ?? new Rectangle(0, 0, 1920, 1080);
        }

        var testMediaPath = args.Length > 5 ? args[5] : null;
        // args[6] (optional): pass "--clock" to also enable the live clock
        // overlay a couple seconds in — isolates whether the overlay's 1s
        // setInterval DOM update is what triggers the freeze, independent of
        // whatever else is different about running under the real app.
        var testClock = args.Length > 6 && args[6] == "--clock";

        Application.Run(new MainForm(Path.GetFullPath(contentDir), bounds, testMediaPath, testClock));
    }
}
