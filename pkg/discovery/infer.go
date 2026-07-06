package discovery

import "strings"

// InferRuntime guesses the app's language from its launch command (best-effort).
func InferRuntime(appCommand string) string {
	c := strings.ToLower(appCommand)
	switch {
	case strings.Contains(c, "go run"), strings.HasPrefix(c, "go "):
		return "go"
	case strings.Contains(c, "python"):
		return "python"
	case strings.Contains(c, "node"), strings.Contains(c, "npm "), strings.Contains(c, "npx "), strings.Contains(c, "yarn "):
		return "node"
	case strings.Contains(c, "dotnet"):
		return "dotnet"
	case strings.Contains(c, "java "), strings.Contains(c, "-jar"):
		return "java"
	default:
		return "unknown"
	}
}

// InferRuntimeFromImage guesses the app's language from its container image
// name (best-effort; conservative — a bespoke image name yields "unknown").
func InferRuntimeFromImage(image string) string {
	c := strings.ToLower(image)
	switch {
	case c == "":
		return "unknown"
	case strings.Contains(c, "golang"):
		return "go"
	case strings.Contains(c, "python"):
		return "python"
	case strings.Contains(c, "node"):
		return "node"
	case strings.Contains(c, "dotnet"), strings.Contains(c, "aspnet"):
		return "dotnet"
	case strings.Contains(c, "openjdk"), strings.Contains(c, "temurin"),
		strings.Contains(c, "java"), strings.Contains(c, "jre"), strings.Contains(c, "jdk"):
		return "java"
	default:
		return "unknown"
	}
}
