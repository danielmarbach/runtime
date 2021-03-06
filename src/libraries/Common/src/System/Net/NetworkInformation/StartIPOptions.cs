// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

namespace System.Net.NetworkInformation
{
    [Flags]
    internal enum StartIPOptions
    {
        None = 0,
        StartIPv4 = 1,
        StartIPv6 = 2,
        Both = 3
    }
}
